import type {
  LanguageModel,
  ModelMessage,
  ToolSet,
  UIMessageStreamWriter,
} from "ai";
import { getAgentContextBudget } from "@/lib/ai/agent-context-budget";
import { createBrowserHandoffNoteProjector } from "@/lib/ai/browser-handoff/context";
import {
  limitModelImageToolResults,
  pruneModelMessages,
} from "@/lib/chat/compaction/prune-tool-outputs";
import { POST_SUMMARIZATION_CONTINUATION_PROMPT } from "@/lib/chat/post-summarization-continuation";
import {
  compactModelMessagesInRun,
  type EnsureSandbox,
} from "@/lib/chat/summarization";
import { CompactionModelPolicy } from "@/lib/chat/summarization/compaction-policy";
import { getSummarizationThresholdTokens } from "@/lib/chat/summarization/constants";
import { estimateSummaryInputTokens } from "@/lib/chat/summarization/helpers";
import {
  buildCompactedRollingBase,
  buildRollingModelMessages,
  estimateToolSchemaTokens,
  RollingCompactionAttempts,
  type RollingModelContextCheckpoint,
} from "@/lib/chat/summarization/rolling-context";
import { isExpandedAgentContextEligible } from "@/lib/experiments/agent-model-context";
import { safeCountTokens } from "@/lib/token-utils";
import type { UsageTracker } from "@/lib/usage-tracker";
import {
  writeSummarizationCleared,
  writeSummarizationCompleted,
} from "@/lib/utils/stream-writer-utils";
import type { SelectedModel, SubscriptionTier, Todo } from "@/types";

export class SubagentContextBudgetError extends Error {
  name = "SubagentContextBudgetError";
}

/**
 * Resolve the same Agent budget and compaction threshold as a normal run.
 * Child records store a routed model key, never the parent's explicit Max/Pro
 * selection, so a child is expanded only when a caller supplies that selection.
 */
export const resolveSubagentContextBudget = ({
  subscription,
  modelId,
  selectedModel,
}: {
  subscription: SubscriptionTier;
  modelId: string;
  selectedModel?: SelectedModel;
}): { maxTokens: number; thresholdTokens: number; expanded: boolean } => {
  const expanded = isExpandedAgentContextEligible(
    subscription,
    "agent",
    selectedModel,
  );
  const maxTokens = getAgentContextBudget({
    enabled: expanded,
    mode: "agent",
    subscription,
    modelId,
  });
  return {
    maxTokens,
    thresholdTokens: getSummarizationThresholdTokens(maxTokens),
    expanded,
  };
};

type HandoffNote = { id: string; text: string };

export type SubagentModelContextOptions = {
  /** Canonical model history before the first generation attempt. */
  history: ModelMessage[];
  /** Task instructions that every request must include verbatim. */
  pinnedMessages: ModelMessage[];
  finalResultToolName: string;
  userId: string;
  chatId: string;
  triggerRunId: string;
  subscription: SubscriptionTier;
  baselineModel: string;
  selectedModel?: SelectedModel;
  systemPrompt: string;
  writer: UIMessageStreamWriter;
  abortSignal: AbortSignal;
  ensureSandbox?: EnsureSandbox;
  getTodos?: () => Todo[];
  usageTracker: UsageTracker;
};

/**
 * Run-scoped context for one subagent execution. It projects the canonical
 * history through the normal Agent rolling checkpoint and compaction engine,
 * keeping parent updates, deadlines and result instructions verbatim. Summaries
 * never touch the parent chat; a resumed child re-compacts persisted history.
 */
export function createSubagentModelContext(
  options: SubagentModelContextOptions,
) {
  const history = [...options.history];
  const pinned = [...options.pinnedMessages];
  const projectHandoffNotes = createBrowserHandoffNoteProjector();
  const attempts = new RollingCompactionAttempts();
  const toolSchemaTokens = new WeakMap<ToolSet, Promise<number>>();
  // The stored checkpoint is mode-neutral. Each request gets the continuation
  // for its actual mode: tool steps must finish through the result tool, while
  // tool-less structured recovery must answer with its schema-bound output.
  const toolContinuation: ModelMessage[] = [
    { role: "user", content: POST_SUMMARIZATION_CONTINUATION_PROMPT },
    {
      role: "user",
      content: `<system-reminder>\nWhen the delegated work is complete, submit it only by calling ${options.finalResultToolName}. A plain-text answer does not complete this subagent.\n</system-reminder>`,
    },
  ];
  const structuredResultContinuation: ModelMessage[] = [
    {
      role: "user",
      content:
        "<system-reminder>\nThe conversation was compacted so you can finish with a smaller context. No tools are available for this request. Respond only with the final structured result matching the provided schema, based on the evidence already gathered. State limitations where the evidence is incomplete.\n</system-reminder>",
    },
  ];
  const continuationFor = (tools: ToolSet | undefined) =>
    tools ? toolContinuation : structuredResultContinuation;
  const compactionPolicy = new CompactionModelPolicy({
    userId: options.userId,
    runId: options.triggerRunId,
    chatId: options.chatId,
    mode: "agent",
    subscription: options.subscription,
    baselineModel: options.baselineModel,
    selectedModel: options.selectedModel,
    // Child records do not carry the parent's moderation authorization.
    platformAuthorized: false,
    expandedAgentContext: isExpandedAgentContextEligible(
      options.subscription,
      "agent",
      options.selectedModel,
    ),
    onDiscardedUsage: (usage) =>
      options.usageTracker.accumulateSummarization(usage),
  });
  let checkpoint: RollingModelContextCheckpoint | undefined;
  let checkpointCreatedThisAttempt = false;
  let summaryCount = 0;
  let lastProviderInputTokens = 0;
  let pendingInjections: ModelMessage[] = [];
  let completedResponses: ModelMessage[] = [];

  const withPinned = (messages: ModelMessage[]): ModelMessage[] => {
    const present = new Set(messages);
    const missing = pinned.filter((message) => !present.has(message));
    return missing.length > 0 ? [...messages, ...missing] : messages;
  };
  const resolveBudget = (modelId: string) =>
    resolveSubagentContextBudget({
      subscription: options.subscription,
      modelId,
      selectedModel: options.selectedModel,
    });
  const estimateTools = (tools: ToolSet | undefined): Promise<number> => {
    if (!tools) return Promise.resolve(0);
    let estimate = toolSchemaTokens.get(tools);
    if (!estimate) {
      estimate = estimateToolSchemaTokens(tools);
      toolSchemaTokens.set(tools, estimate);
    }
    return estimate;
  };

  return {
    /** Snapshot for streamText; prepareStep replaces every request with a projection. */
    beginAttempt(): ModelMessage[] {
      pendingInjections = [];
      completedResponses = [];
      checkpointCreatedThisAttempt = false;
      // Raw cursors restart with each attempt's SDK history; the
      // unproductive-compaction bound continues across attempts.
      attempts.lastRawMessageCount = -1;
      return [...history];
    },

    /** A live runtime instruction: kept verbatim and committed after this attempt. */
    inject(message: ModelMessage): void {
      pinned.push(message);
      pendingInjections.push(message);
    },

    /** A runtime instruction between attempts, such as result recovery. */
    appendInstruction(message: ModelMessage): void {
      pinned.push(message);
      history.push(message);
    },

    recordStep({
      inputTokens,
      responseMessages,
      thresholdTokens,
    }: {
      inputTokens: number | undefined;
      responseMessages: ModelMessage[] | undefined;
      thresholdTokens: number;
    }): void {
      attempts.confirm(inputTokens, thresholdTokens);
      lastProviderInputTokens = inputTokens ?? 0;
      if (responseMessages) completedResponses = responseMessages;
    },

    /**
     * Commit this attempt's injected instructions and responses to the canonical
     * history. A checkpoint taken during the attempt indexes completed SDK
     * responses, so a failed attempt keeps only those after compaction.
     */
    finishAttempt({
      responseMessages,
      partialMessages,
    }: {
      responseMessages?: ModelMessage[];
      partialMessages?: ModelMessage[];
    }): void {
      const responses =
        responseMessages ??
        (checkpointCreatedThisAttempt
          ? completedResponses
          : (partialMessages ?? []));
      history.push(...pendingInjections, ...responses);
      if (checkpoint && checkpointCreatedThisAttempt) {
        checkpoint = {
          ...checkpoint,
          rawMessageCursor:
            checkpoint.rawMessageCursor + pendingInjections.length,
        };
      }
      pendingInjections = [];
      completedResponses = [];
      checkpointCreatedThisAttempt = false;
    },

    resolveBudget,

    /**
     * Prepare one provider request. Compacts above the Agent threshold, then
     * refuses to send a request whose estimate still exceeds the budget.
     */
    async prepareStep({
      rawMessages,
      languageModel,
      modelId,
      system,
      tools,
      getHandoffNotes,
      afterCompaction,
    }: {
      rawMessages: ModelMessage[];
      languageModel: LanguageModel;
      modelId: string;
      system: string;
      /** Tools sent with this request; omitted for structured result recovery. */
      tools?: ToolSet;
      getHandoffNotes: () => Promise<HandoffNote[]>;
      /** Re-check runtime fences after a summary request's await. */
      afterCompaction?: () => Promise<void>;
    }): Promise<ModelMessage[]> {
      const budget = resolveBudget(modelId);
      const overheadTokens =
        safeCountTokens(system) + (await estimateTools(tools));
      const continuation = continuationFor(tools);
      let rolling = withPinned(
        buildRollingModelMessages(
          rawMessages,
          checkpoint && {
            ...checkpoint,
            baseMessages: [...checkpoint.baseMessages, ...continuation],
          },
        ),
      );
      let compactedPrefixLength: number | undefined;
      const estimatedTokens =
        estimateSummaryInputTokens(
          limitModelImageToolResults(rolling as Array<Record<string, unknown>>)
            .messages as ModelMessage[],
        ) + overheadTokens;
      if (
        (lastProviderInputTokens > budget.thresholdTokens ||
          estimatedTokens > budget.thresholdTokens) &&
        attempts.canCompact() &&
        rawMessages.length !== attempts.lastRawMessageCount
      ) {
        attempts.record(rawMessages.length);
        const result = await compactModelMessagesInRun({
          compactionPolicy,
          modelMessages: rolling,
          transcriptModelMessages: rawMessages,
          subscription: options.subscription,
          languageModel,
          mode: "agent",
          writer: options.writer,
          chatId: options.chatId,
          todos: options.getTodos?.() ?? [],
          abortSignal: options.abortSignal,
          ensureSandbox: options.ensureSandbox,
          systemPromptTokens: overheadTokens,
          providerInputTokens: lastProviderInputTokens,
          chatSystemPrompt: options.systemPrompt,
          tools,
          maxTokens: budget.maxTokens,
          compactionIndex: summaryCount + 1,
          hasExistingSummary: summaryCount > 0,
        });
        if (result) {
          // Bill an accepted or rejected summary once; discarded provider
          // attempts were already recorded through the compaction policy.
          if (result.summarizationUsage)
            options.usageTracker.accumulateSummarization(
              result.summarizationUsage,
            );
          const next = await buildCompactedRollingBase({
            compaction: result,
            tools: tools ?? {},
            pinnedMessages: pinned,
            // Replace a previous checkpoint's continuation; never carry the
            // other mode's instructions forward in the retained tail.
            sourceMessages: rolling.filter(
              (message) =>
                !toolContinuation.includes(message) &&
                !structuredResultContinuation.includes(message),
            ),
            trailingMessages: continuation,
          });
          if (next.effective) {
            summaryCount++;
            checkpoint = {
              baseMessages: next.baseMessages.slice(
                0,
                next.baseMessages.length - continuation.length,
              ),
              rawMessageCursor: rawMessages.length,
            };
            checkpointCreatedThisAttempt = true;
            rolling = next.baseMessages;
            compactedPrefixLength = next.summaryMessageCount;
            // The previous provider count measured the replaced history.
            lastProviderInputTokens = 0;
            writeSummarizationCompleted(options.writer, summaryCount);
          } else {
            writeSummarizationCleared(options.writer, summaryCount + 1);
          }
        }
        await afterCompaction?.();
      }

      const notes = await getHandoffNotes();
      const projected = projectHandoffNotes(
        rolling,
        notes,
        compactedPrefixLength,
      );
      const prepared = pruneModelMessages(
        limitModelImageToolResults(projected as Array<Record<string, unknown>>)
          .messages,
      ).messages as ModelMessage[];
      const preparedTokens =
        estimateSummaryInputTokens(prepared) + overheadTokens;
      if (attempts.pendingVerdict)
        attempts.pendingInputEstimate = preparedTokens;
      if (preparedTokens > budget.maxTokens) {
        throw new SubagentContextBudgetError(
          "Subagent context could not be compacted to fit the model budget.",
        );
      }
      return prepared;
    },
  };
}

export type SubagentModelContext = ReturnType<
  typeof createSubagentModelContext
>;
