import "server-only";

import {
  UIMessage,
  UIMessageStreamWriter,
  LanguageModel,
  ToolSet,
  ModelMessage,
} from "ai";
import { v4 as uuidv4 } from "uuid";
import { SubscriptionTier, ChatMode, Todo, AnySandbox } from "@/types";
import { countMessagesTokens } from "@/lib/token-utils";
import {
  writeSummarizationStarted,
  writeSummarizationCompleted,
} from "@/lib/utils/stream-writer-utils";
import { isE2BSandbox } from "@/lib/ai/tools/utils/sandbox-types";
import type { Id } from "@/convex/_generated/dataModel";
import type { ProviderPromptPressure } from "./provider-pressure";

import {
  MESSAGES_TO_KEEP_UNSUMMARIZED,
  getSummaryInputMaxTokens,
  getSummarizationThresholdTokens,
} from "./constants";
import {
  NO_SUMMARIZATION,
  isAboveTokenThreshold,
  generateSummaryText,
  buildSummaryMessage,
  persistSummary,
  isSummaryMessage,
  extractSummaryText,
  buildSummaryPersistenceMetadata,
  resolveSummarizationMaxTokens,
} from "./helpers";
import type { SummarizationResult } from "./helpers";
import {
  getRetainedTailBudgetTokens,
  selectRetainedTailForSummarization,
} from "./retained-tail";

export type { SummarizationResult, SummarizationUsage } from "./helpers";

export type EnsureSandbox = () => Promise<AnySandbox>;

type CompactionLogReason =
  | "provider_pressure"
  | "provider_input_tokens"
  | "estimated_token_threshold";

export interface CheckAndSummarizeOptions {
  uiMessages: UIMessage[];
  subscription: SubscriptionTier;
  languageModel: LanguageModel;
  mode: ChatMode;
  writer: UIMessageStreamWriter;
  chatId: string | null;
  fileTokens?: Record<Id<"files">, number>;
  todos?: Todo[];
  abortSignal?: AbortSignal;
  ensureSandbox?: EnsureSandbox;
  systemPromptTokens?: number;
  providerInputTokens?: number;
  chatSystemPrompt?: string;
  tools?: ToolSet;
  providerOptions?: Record<string, Record<string, unknown>>;
  modelMessages?: ModelMessage[];
  transcriptMessages?: UIMessage[];
  maxTokensOverride?: number;
  providerPromptPressure?: ProviderPromptPressure | null;
}

/**
 * Builds the instructional notice appended to summaryText pointing the agent
 * to the saved transcript file on the sandbox filesystem.
 */
const buildTranscriptNotice = (path: string): string => `

Transcript location:
   This is the full JSON transcript of your past conversation with the user (pre- and post-summary): ${path}

   If anything about the task or current state is unclear (missing context, ambiguous requirements, uncertain decisions, exact wording, IDs/paths, errors/logs, tool inputs/outputs), you should consult this transcript rather than guessing.

   How to use it:
   - Search first for relevant keywords (task name, filenames, IDs, errors, tool names).
   - Then read a small window around the matching lines to reconstruct intent and state.
   - Avoid reading the entire file; it can be very large.

   Format:
   - JSON array of messages, each with "role" and "parts" (or "content" for model messages)
   - Tool calls: parts with type "tool-<name>" containing "input" and "output" fields
   - Tool results (model format): separate role "tool" messages with "tool-result" content
   - Text: parts with type "text"
   - Reasoning: parts with type "reasoning"`;

const summarizeFileTokensForLog = (fileTokens: Record<Id<"files">, number>) => {
  const values = Object.values(fileTokens).filter(
    (tokens) => Number.isFinite(tokens) && tokens > 0,
  );

  return {
    file_count: values.length,
    total_file_tokens: values.reduce((total, tokens) => total + tokens, 0),
    largest_file_tokens: values.length > 0 ? Math.max(...values) : 0,
  };
};

const getCompactionLogReason = ({
  providerPromptPressure,
  providerInputTokens,
  summarizationThreshold,
}: {
  providerPromptPressure?: ProviderPromptPressure | null;
  providerInputTokens: number;
  summarizationThreshold: number;
}): CompactionLogReason => {
  if (providerPromptPressure) return "provider_pressure";
  if (providerInputTokens > summarizationThreshold) {
    return "provider_input_tokens";
  }
  return "estimated_token_threshold";
};

const logContextCompactionStarted = ({
  chatId,
  mode,
  subscription,
  reason,
  totalEstimatedTokens,
  systemPromptTokens,
  providerInputTokens,
  maxTokens,
  summarizationThreshold,
  providerPromptPressure,
  fileTokens,
  cutoffMessageId,
  retainedTail,
}: {
  chatId: string | null;
  mode: ChatMode;
  subscription: SubscriptionTier;
  reason: CompactionLogReason;
  totalEstimatedTokens: number;
  systemPromptTokens: number;
  providerInputTokens: number;
  maxTokens: number;
  summarizationThreshold: number;
  providerPromptPressure?: ProviderPromptPressure | null;
  fileTokens: Record<Id<"files">, number>;
  cutoffMessageId: string;
  retainedTail?: {
    budget_tokens: number;
    retained_tokens: number;
    retained_message_count: number;
    retained_part_count: number;
    projected_part_count: number;
  };
}) => {
  const fileTokenSummary = summarizeFileTokensForLog(fileTokens);

  console.info(
    JSON.stringify({
      level: "info",
      event: "chat_context_compaction_started",
      service: "chat-handler",
      timestamp: new Date().toISOString(),
      chat_id: chatId ?? undefined,
      mode,
      subscription,
      reason,
      total_estimated_tokens: totalEstimatedTokens,
      system_prompt_tokens: systemPromptTokens,
      provider_input_tokens: providerInputTokens,
      max_tokens: maxTokens,
      threshold_tokens: summarizationThreshold,
      ...fileTokenSummary,
      provider_pressure_reason: providerPromptPressure?.reason,
      provider_pressure_reasons: providerPromptPressure?.reasons,
      provider_pressure_serialized_message_bytes:
        providerPromptPressure?.serializedMessageBytes,
      provider_pressure_tool_result_count:
        providerPromptPressure?.toolResultCount,
      provider_pressure_message_count: providerPromptPressure?.messageCount,
      cutoff_message_id: cutoffMessageId,
      retained_tail_budget_tokens: retainedTail?.budget_tokens,
      retained_tail_tokens: retainedTail?.retained_tokens,
      retained_tail_message_count: retainedTail?.retained_message_count,
      retained_tail_part_count: retainedTail?.retained_part_count,
      retained_tail_projected_part_count: retainedTail?.projected_part_count,
    }),
  );
};

/**
 * Writes a JSON transcript of the summarized messages to the sandbox.
 * E2B (cloud) persists to ~/agent-transcripts/, local Docker to /tmp/agent-transcripts/.
 *
 * Content is written as a Buffer (not a string) so that ConvexSandbox's binary
 * chunking path is used, avoiding the shell argument size limits that occur when
 * large strings are embedded in heredoc commands.
 *
 * Returns the file path if saved, or null on failure.
 */
const saveTranscriptToSandbox = async (
  messages: UIMessage[],
  sandbox: AnySandbox,
  modelMessages?: ModelMessage[],
): Promise<string | null> => {
  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const transcriptId = uuidv4();
      const dir = isE2BSandbox(sandbox)
        ? "/home/user/agent-transcripts"
        : "/tmp/agent-transcripts";
      const path = `${dir}/${transcriptId}.json`;

      // E2B needs an explicit mkdir since its files.write doesn't create parents.
      // CentrifugoSandbox's files.write already calls ensureDirectory internally
      // with proper Windows path/shell handling, so skip the raw mkdir for it.
      if (isE2BSandbox(sandbox)) {
        await sandbox.commands.run(`mkdir -p ${dir}`, { timeoutMs: 5000 });
      }

      // Save as structured JSON — model messages (mid-stream, with separate
      // tool-call/tool-result parts) when available, otherwise UI messages
      const content = JSON.stringify(modelMessages ?? messages, null, 2);
      if (isE2BSandbox(sandbox)) {
        // E2B uploads via HTTP — no shell argument limits, string is fine
        await sandbox.files.write(path, content);
      } else {
        // ConvexSandbox/TauriSandbox: pass as ArrayBuffer to trigger binary
        // chunking in ConvexSandbox, avoiding shell argument size limits that
        // occur when large strings are embedded in heredoc commands.
        const buf = new TextEncoder().encode(content);
        await sandbox.files.write(path, buf.buffer as ArrayBuffer);
      }

      return path;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const isPublishError = errorMsg.includes("Failed to publish");
      const isUnrecoverable =
        errorMsg.includes("connection closed") ||
        errorMsg.includes("connection lost") ||
        errorMsg.includes("program not found");
      if (isPublishError && !isUnrecoverable && attempt < maxRetries) {
        console.warn(
          `[Summarization] Transcript save failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying...`,
          error,
        );
        // Brief delay before retry to allow connection recovery
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
      console.warn("[Summarization] Failed to save transcript:", error);
      return null;
    }
  }
  return null;
};

export const checkAndSummarizeIfNeeded = async ({
  uiMessages,
  subscription,
  languageModel,
  mode,
  writer,
  chatId,
  fileTokens = {},
  todos = [],
  abortSignal,
  ensureSandbox,
  systemPromptTokens = 0,
  providerInputTokens = 0,
  chatSystemPrompt = "",
  tools,
  providerOptions,
  modelMessages,
  transcriptMessages,
  maxTokensOverride,
  providerPromptPressure,
}: CheckAndSummarizeOptions): Promise<SummarizationResult> => {
  // Detect and separate synthetic summary message from real messages
  let realMessages: UIMessage[];
  let existingSummaryText: string | null = null;
  let existingSummaryMessage: UIMessage | null = null;

  if (uiMessages.length > 0 && isSummaryMessage(uiMessages[0])) {
    realMessages = uiMessages.slice(1);
    existingSummaryText = extractSummaryText(uiMessages[0]);
    existingSummaryMessage = uiMessages[0];
  } else {
    realMessages = uiMessages;
  }

  // Guard: need enough real messages to split
  if (realMessages.length <= MESSAGES_TO_KEEP_UNSUMMARIZED) {
    return NO_SUMMARIZATION(uiMessages);
  }

  // Check token threshold on full messages (including summary) to determine need
  const effectiveMaxTokensOverride =
    providerPromptPressure?.summarizationMaxTokensOverride ?? maxTokensOverride;
  const maxTokens = resolveSummarizationMaxTokens(
    subscription,
    effectiveMaxTokensOverride,
  );
  const summarizationThreshold = getSummarizationThresholdTokens(maxTokens);
  const totalEstimatedTokens =
    countMessagesTokens(uiMessages, fileTokens) + systemPromptTokens;
  if (
    !providerPromptPressure &&
    !isAboveTokenThreshold(
      uiMessages,
      subscription,
      fileTokens,
      systemPromptTokens,
      providerInputTokens,
      effectiveMaxTokensOverride,
    )
  ) {
    return NO_SUMMARIZATION(uiMessages);
  }

  const retainedTailBudget = getRetainedTailBudgetTokens(
    summarizationThreshold,
  );
  let tailSelection = selectRetainedTailForSummarization(realMessages, {
    budgetTokens: retainedTailBudget,
    fileTokens,
  });

  if (
    tailSelection.headMessages.length === 0 &&
    providerPromptPressure &&
    !tailSelection.retainedTail?.projected_part_count
  ) {
    tailSelection = {
      headMessages: realMessages,
      tailMessages: [],
      cutoffMessageId: realMessages.at(-1)?.id ?? null,
    };
  }

  const hasSummarizableHead =
    tailSelection.headMessages.length > 0 ||
    existingSummaryMessage !== null ||
    (tailSelection.retainedTail?.projected_part_count ?? 0) > 0;

  if (!hasSummarizableHead || !tailSelection.cutoffMessageId) {
    return NO_SUMMARIZATION(uiMessages);
  }

  const messagesToSummarize = existingSummaryMessage
    ? [existingSummaryMessage, ...tailSelection.headMessages]
    : tailSelection.headMessages;

  const cutoffMessageId = tailSelection.cutoffMessageId;
  logContextCompactionStarted({
    chatId,
    mode,
    subscription,
    reason: getCompactionLogReason({
      providerPromptPressure,
      providerInputTokens,
      summarizationThreshold,
    }),
    totalEstimatedTokens,
    systemPromptTokens,
    providerInputTokens,
    maxTokens,
    summarizationThreshold,
    providerPromptPressure,
    fileTokens,
    cutoffMessageId,
    retainedTail: tailSelection.retainedTail,
  });

  writeSummarizationStarted(writer);

  try {
    // Run summary generation and transcript saving in parallel — they are
    // independent (transcript is formatted from raw messages, not the summary).
    const summaryPromise = generateSummaryText(
      messagesToSummarize,
      languageModel,
      mode,
      chatSystemPrompt,
      !!existingSummaryText,
      tools,
      providerOptions,
      abortSignal,
      undefined,
      getSummaryInputMaxTokens(maxTokens),
    );

    // In agent modes, save the full transcript of summarized messages to the sandbox
    // so the agent can consult the raw conversation later if context is lost
    const transcriptPromise: Promise<string | null> =
      ensureSandbox && mode === "agent"
        ? ensureSandbox()
            .then((sandbox) =>
              saveTranscriptToSandbox(
                transcriptMessages ?? tailSelection.headMessages,
                sandbox,
                modelMessages,
              ),
            )
            .catch((error) => {
              console.error(
                "[Summarization] Failed to ensure sandbox for transcript:",
                error,
              );
              return null;
            })
        : Promise.resolve(null);

    const [summaryResult, savedPath] = await Promise.all([
      summaryPromise,
      transcriptPromise,
    ]);

    const { text: summaryText, usage: summarizationUsage } = summaryResult;
    let finalSummaryText = summaryText;
    if (savedPath) {
      finalSummaryText += buildTranscriptNotice(savedPath);
    }

    const summaryMessage = buildSummaryMessage(finalSummaryText, todos);
    const metadata = buildSummaryPersistenceMetadata({
      providerInputTokens,
      threshold: summarizationThreshold,
      languageModel,
      transcriptPath: savedPath,
      retainedTail: tailSelection.retainedTail,
      reason: providerPromptPressure ? "provider_pressure" : undefined,
    });

    await persistSummary(chatId, finalSummaryText, cutoffMessageId, metadata);

    return {
      needsSummarization: true,
      summarizedMessages: [summaryMessage, ...tailSelection.tailMessages],
      cutoffMessageId,
      summaryText: finalSummaryText,
      summarizationUsage,
    };
  } catch (error) {
    if (abortSignal?.aborted) {
      throw error;
    }
    console.error("[Summarization] Failed:", error);
    return NO_SUMMARIZATION(uiMessages);
  } finally {
    if (!abortSignal?.aborted) {
      writeSummarizationCompleted(writer);
    }
  }
};
