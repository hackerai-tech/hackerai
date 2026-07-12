/**
 * Shared streamText factory for the agent loop.
 *
 * Both the Next.js chat handler and the trigger.dev agent-long task
 * run the same multi-step tool loop. This module owns the single canonical
 * implementation of that loop — prepareStep, stopWhen, onChunk, onStepFinish,
 * streamText.onFinish, onError, onAbort — so divergence is impossible.
 *
 * Callers supply:
 *  - AgentStreamState   a mutable object; the runner reads and writes it in
 *                       place so callers see every update (finalMessages,
 *                       ctxUsage, stop-flags, finish reason, …).
 *  - AgentStreamContext immutable config + stable dependency references.
 */

import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  type ModelMessage,
  type UIMessage,
  type UIMessageStreamWriter,
  type ToolSet,
} from "ai";
import {
  buildProviderOptions,
  buildSystemPrompt,
  addCacheBreakpointToLastUserMessage,
  applyPrepareStepReminders,
  runSummarizationStep,
  getFallbackSlugs,
  isXaiSafetyError,
} from "@/lib/api/chat-stream-helpers";
import {
  elapsedTimeExceeds,
  tokenExhaustedAfterSummarization,
  doomLoopDetected,
  PREEMPTIVE_TIMEOUT_FINISH_REASON,
  TOKEN_EXHAUSTION_FINISH_REASON,
  DOOM_LOOP_FINISH_REASON,
  BUDGET_EXHAUSTION_FINISH_REASON,
  AGENT_RUN_SPEND_CAP_FINISH_REASON,
  POST_SUMMARIZATION_INCOMPLETE_FINISH_REASON,
} from "@/lib/chat/stop-conditions";
import {
  detectDoomLoop,
  generateDoomLoopNudge,
} from "@/lib/chat/doom-loop-detection";
import {
  createAssistantContentLoopMonitor,
  type AssistantContentLoopDetection,
} from "@/lib/chat/agent-long-provider-retry";
import {
  filterEmptyAssistantMessages,
  repairAnthropicModelMessagesWithTelemetry,
  pruneToolOutputs,
  pruneModelMessages,
} from "@/lib/chat/compaction/prune-tool-outputs";
import {
  isProviderMultimodalToolResultRejectionError,
  toolResultsContainImageViewResult,
  uiMessagesContainImageViewResult,
} from "@/lib/chat/multimodal-tool-result-recovery";
import { isAnthropicModel, isDeepSeekModel } from "@/lib/ai/providers";
import { MAX_OUTPUT_TOKENS } from "@/lib/ai/output-limits";
import { ptySessionManager } from "@/lib/ai/tools/utils/pty-session-manager";
import { getMaxTokensForSubscription } from "@/lib/token-utils";
import {
  getSummarizationThresholdTokens,
  MAX_CONTEXT_COMPACTION_ATTEMPTS_PER_AGENT_STREAM,
  ROLLING_COMPACTION_MAX_SIZE_RATIO,
} from "@/lib/chat/summarization/constants";
import { compactModelMessagesInRun } from "@/lib/chat/summarization";
import { getLatestCompletedToolTransaction } from "@/lib/chat/summarization/helpers";
import { getProviderPromptPressure } from "@/lib/chat/summarization/provider-pressure";
import { getMaxStepsForUser } from "@/lib/chat/chat-processor";
import {
  isIncompletePostSummarizationStop,
  POST_SUMMARIZATION_CONTINUATION_PROMPT,
} from "@/lib/chat/post-summarization-continuation";
import { createPromptSerializationTools } from "@/lib/ai/tools/prompt-serialization";
import {
  writeSummarizationCleared,
  writeSummarizationCompleted,
} from "@/lib/utils/stream-writer-utils";
import {
  extractOpenRouterMetadata,
  mergeOpenRouterMetadata,
} from "@/lib/api/openrouter-metadata";
import { getOpenRouterUpstreamInferenceCostFromUsageRaw } from "@/lib/provider-usage-cost";
import { classifyProviderOverflowError } from "@/lib/utils/error-utils";
import type { UsageTracker } from "@/lib/usage-tracker";
import type {
  BudgetAbortDetails,
  BudgetMonitor,
} from "@/lib/chat/budget-monitor";
import type { UsageRefundTracker } from "@/lib/rate-limit";
import type {
  ProviderReasoningOverride,
  SummarizationTracker,
} from "@/lib/api/chat-stream-helpers";
import type { ChatLogger } from "@/lib/api/chat-logger";
import type { ChatApiEndpoint } from "@/lib/api/agent-endpoints";
import type { createTrackedProvider } from "@/lib/ai/providers";
import type { ProviderRequestDiagnostics } from "@/lib/logger";
import type { ChatMode, SubscriptionTier } from "@/types";

const AGENT_VISION_MODEL = "model-kimi-k2.7-code";

export const resolveAgentModelForImageToolResults = (
  modelName: string,
  mode: ChatMode,
  hasImageToolResults: boolean,
): string =>
  mode === "agent" &&
  hasImageToolResults &&
  (modelName === "model-glm-5.2" || isDeepSeekModel(modelName))
    ? AGENT_VISION_MODEL
    : modelName;

export type RollingModelContextCheckpoint = {
  /** Latest compacted provider context, excluding later raw SDK responses. */
  baseMessages: ModelMessage[];
  /** Number of raw SDK messages covered by baseMessages. */
  rawMessageCursor: number;
};

/**
 * AI SDK prepareStep overrides apply to one request only. Rebase its cumulative
 * raw history onto our latest compacted checkpoint for every later request.
 */
export const buildRollingModelMessages = (
  rawMessages: ModelMessage[],
  checkpoint?: RollingModelContextCheckpoint,
): ModelMessage[] => {
  if (!checkpoint) return rawMessages;
  const cursor = Math.min(checkpoint.rawMessageCursor, rawMessages.length);
  return [...checkpoint.baseMessages, ...rawMessages.slice(cursor)];
};

export const isRollingCompactionEffective = (
  previousMessages: ModelMessage[],
  compactedMessages: ModelMessage[],
): boolean => {
  const previousBytes = getSerializedBytes(previousMessages);
  const compactedBytes = getSerializedBytes(compactedMessages);
  if (previousBytes === undefined || compactedBytes === undefined) return true;
  return compactedBytes < previousBytes * ROLLING_COMPACTION_MAX_SIZE_RATIO;
};

// ---------------------------------------------------------------------------
// Mutable state — the runner updates these in place; callers read them back.
// ---------------------------------------------------------------------------

export type AgentStreamState = {
  /** Current UI messages fed into the model; updated each prepareStep. */
  finalMessages: UIMessage[];
  /** Raw UI messages captured before in-memory pruning, for transcript sidecars. */
  transcriptSourceMessages?: UIMessage[];
  /** Context-window usage data; updated after summarization and each step. */
  ctxUsage: { usedTokens: number; maxTokens: number };
  lastStepInputTokens: number;
  /** Set in streamText.onFinish; read by the caller's toUIMessageStream.onFinish. */
  streamFinishReason: string | undefined;
  streamUsage: Record<string, unknown> | undefined;
  responseModel: string | undefined;
  /** Original provider/AI SDK error captured from streamText.onError. */
  providerError: unknown;
  /** True when a provider rejected an image-bearing tool result. */
  providerRejectedMultimodalToolResults: boolean;
  /** Stop-condition flags set by the respective onFired callbacks. */
  stoppedDueToTokenExhaustion: boolean;
  /** Maps to stoppedDueToPreemptiveTimeout in chat-handler, stoppedDueToElapsedTimeout in agent-long. */
  stoppedDueToElapsedTimeout: boolean;
  stoppedDueToDoomLoop: boolean;
  stoppedDueToAssistantContentLoop: boolean;
  assistantContentLoopDetection: AssistantContentLoopDetection | undefined;
  stoppedDueToBudgetExhaustion: boolean;
  stoppedDueToAgentRunSpendCap: boolean;
  stoppedDueToPostSummarizationIncomplete: boolean;
  postSummarizationContinuationActive: boolean;
  postSummarizationToolCallCount: number;
  postSummarizationText: string;
  budgetAbortDetails: BudgetAbortDetails | undefined;
};

export function initAgentStreamState(
  finalMessages: UIMessage[],
  ctxUsage: { usedTokens: number; maxTokens: number },
): AgentStreamState {
  return {
    finalMessages,
    ctxUsage,
    lastStepInputTokens: 0,
    streamFinishReason: undefined,
    streamUsage: undefined,
    responseModel: undefined,
    providerError: undefined,
    providerRejectedMultimodalToolResults: false,
    stoppedDueToTokenExhaustion: false,
    stoppedDueToElapsedTimeout: false,
    stoppedDueToDoomLoop: false,
    stoppedDueToAssistantContentLoop: false,
    assistantContentLoopDetection: undefined,
    stoppedDueToBudgetExhaustion: false,
    stoppedDueToAgentRunSpendCap: false,
    stoppedDueToPostSummarizationIncomplete: false,
    postSummarizationContinuationActive: false,
    postSummarizationToolCallCount: 0,
    postSummarizationText: "",
    budgetAbortDetails: undefined,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const ESTIMATED_BYTES_PER_TOKEN = 4;

const incrementCount = (counts: Record<string, number>, key: string): void => {
  counts[key] = (counts[key] ?? 0) + 1;
};

const getSerializedBytes = (value: unknown): number | undefined => {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return undefined;
  }
};

const getContentType = (part: unknown): string => {
  if (isRecord(part) && typeof part.type === "string") return part.type;
  if (part == null) return "empty";
  if (Array.isArray(part)) return "array";
  return typeof part;
};

const summarizeContentTypes = (content: unknown): string[] => {
  if (typeof content === "string") return content.trim() ? ["text"] : ["empty"];
  if (!Array.isArray(content)) return [getContentType(content)];
  if (content.length === 0) return ["empty"];
  return content.map(getContentType);
};

const addContentPartCounts = (
  content: unknown,
  counts: Record<string, number>,
): void => {
  for (const type of summarizeContentTypes(content)) {
    incrementCount(counts, type);
  }
};

const contentHasToolCall = (content: unknown): boolean =>
  Array.isArray(content) &&
  content.some((part) => isRecord(part) && part.type === "tool-call");

const combineAbortSignals = (signals: AbortSignal[]): AbortSignal => {
  const abortSignalAny = (
    AbortSignal as typeof AbortSignal & {
      any?: (signals: AbortSignal[]) => AbortSignal;
    }
  ).any;
  if (typeof abortSignalAny === "function") {
    return abortSignalAny(signals);
  }

  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
  };

  for (const signal of signals) {
    if (signal.aborted) {
      abort();
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
  }

  return controller.signal;
};

const summarizeProviderOptions = (
  providerOptions: unknown,
): Pick<
  ProviderRequestDiagnostics,
  | "reasoning_enabled"
  | "reasoning_effort"
  | "fallback_model_count"
  | "fallback_model_slugs"
  | "has_user_attribution"
> => {
  const openrouter =
    isRecord(providerOptions) && isRecord(providerOptions.openrouter)
      ? providerOptions.openrouter
      : undefined;
  const reasoning = isRecord(openrouter?.reasoning)
    ? openrouter.reasoning
    : undefined;
  const fallbackModelSlugs = Array.isArray(openrouter?.models)
    ? openrouter.models.filter(
        (model): model is string => typeof model === "string",
      )
    : [];

  return {
    reasoning_enabled:
      typeof reasoning?.enabled === "boolean" ? reasoning.enabled : undefined,
    reasoning_effort:
      typeof reasoning?.effort === "string" ? reasoning.effort : undefined,
    fallback_model_count: fallbackModelSlugs.length,
    fallback_model_slugs:
      fallbackModelSlugs.length > 0 ? fallbackModelSlugs : undefined,
    has_user_attribution: typeof openrouter?.user === "string",
  };
};

const buildProviderRequestDiagnostics = (args: {
  modelName: string;
  requestedSlug?: string;
  stepIndex: number;
  source: ProviderRequestDiagnostics["source"];
  messages: ModelMessage[];
  providerOptions: unknown;
  activeTools: readonly unknown[] | undefined;
  availableToolCount: number;
  contextUsage: { usedTokens: number; maxTokens: number };
  systemTokens: number;
  maxOutputTokens: number;
  hasMultimodalToolResults: boolean;
}): ProviderRequestDiagnostics => {
  const roleCounts: Record<string, number> = {};
  const contentPartCounts: Record<string, number> = {};

  for (const message of args.messages) {
    const messageRecord = message as Record<string, unknown>;
    const role =
      typeof messageRecord.role === "string" ? messageRecord.role : "unknown";
    incrementCount(roleCounts, role);
    addContentPartCounts(messageRecord.content, contentPartCounts);
  }

  const lastMessage = args.messages.at(-1) as
    Record<string, unknown> | undefined;
  const serializedBytes = getSerializedBytes(args.messages);
  const contextUsedPercent =
    args.contextUsage.maxTokens > 0
      ? Math.round(
          (args.contextUsage.usedTokens / args.contextUsage.maxTokens) * 1000,
        ) / 10
      : 0;

  return {
    model: args.modelName,
    requested_model_slug: args.requestedSlug,
    step_index: args.stepIndex,
    source: args.source,
    message_count: args.messages.length,
    role_counts: roleCounts,
    content_part_counts: contentPartCounts,
    last_message_role:
      typeof lastMessage?.role === "string" ? lastMessage.role : undefined,
    last_message_content_types: summarizeContentTypes(lastMessage?.content),
    trailing_assistant_has_tool_call:
      lastMessage?.role === "assistant"
        ? contentHasToolCall(lastMessage.content)
        : undefined,
    serialized_message_bytes: serializedBytes,
    estimated_serialized_message_tokens:
      serializedBytes != null
        ? Math.ceil(serializedBytes / ESTIMATED_BYTES_PER_TOKEN)
        : undefined,
    context_used_tokens: args.contextUsage.usedTokens,
    context_max_tokens: args.contextUsage.maxTokens,
    context_used_percent: contextUsedPercent,
    system_tokens: args.systemTokens,
    max_output_tokens: args.maxOutputTokens,
    tool_count: args.availableToolCount,
    active_tool_count: args.activeTools?.length ?? args.availableToolCount,
    active_tools_mode: args.activeTools ? "subset" : "all",
    ...summarizeProviderOptions(args.providerOptions),
    has_multimodal_tool_results: args.hasMultimodalToolResults,
  };
};

// ---------------------------------------------------------------------------
// Immutable context — everything the runner needs besides mutable state.
// ---------------------------------------------------------------------------

export type AgentStreamContext = {
  trackedProvider: ReturnType<typeof createTrackedProvider>;
  currentSystemPrompt: string;
  tools: ToolSet;
  mode: ChatMode;
  endpoint: ChatApiEndpoint;
  userId: string;
  subscription: SubscriptionTier;
  chatId: string;
  temporary: boolean | undefined;
  fileTokens: Record<string, number>;
  noteInjectionOpts: {
    userId: string;
    subscription: SubscriptionTier;
    shouldIncludeNotes: boolean;
    isTemporary: boolean | undefined;
  };
  systemPromptTokens: number;
  ctxSystemTokens: number;
  ctxMaxTokens: number;
  streamStartTime: number;
  contextUsageOn: boolean;
  isReasoningModel: boolean;
  providerReasoningOverride?: {
    modelName: string;
    reasoning: ProviderReasoningOverride;
  };
  /** elapsedTimeExceeds threshold; callers supply their platform ceiling. */
  maxDurationMs: number;

  // Dependencies
  writer: UIMessageStreamWriter;
  abortController: AbortController;
  summarizationTracker: SummarizationTracker;
  usageTracker: UsageTracker;
  budgetMonitor: BudgetMonitor | null;
  sandboxManager: {
    getSandboxType(toolName: string): string | undefined;
    supportsInteractivePty?(): Promise<boolean>;
  };
  getTodoManager: () => { getAllTodos: () => import("@/types").Todo[] };
  ensureSandbox: import("@/lib/chat/summarization").EnsureSandbox;
  chatLogger: ChatLogger | undefined;
  usageRefundTracker: UsageRefundTracker;
  onBudgetAbort?: (details: BudgetAbortDetails & { model: string }) => void;
  settleUsageAfterStep?: (args: {
    currentCostDollars: number;
    force: boolean;
    model: string;
  }) => Promise<void>;

  /**
   * Platform-specific: return a finish-reason string if a hard platform
   * timeout fired synchronously (Vercel: preemptiveTimeout.isPreemptive()),
   * or null when no hard timeout applies (trigger.dev: always null).
   */
  getHardTimeoutReason: () => string | null;
};

// ---------------------------------------------------------------------------
// The shared factory — returns a streamText result (not awaited).
// ---------------------------------------------------------------------------

export async function createAgentStream(
  modelName: string,
  ctx: AgentStreamContext,
  state: AgentStreamState,
) {
  const stepUsageCostIndexes: Array<number | undefined> = [];
  const getActiveToolsWithExclusions = async (
    excludedToolNames: ReadonlySet<string> = new Set(),
  ): Promise<Array<keyof typeof ctx.tools> | undefined> => {
    const hasExclusions = excludedToolNames.size > 0;
    const withoutExcludedTools = (toolName: string) =>
      !excludedToolNames.has(toolName);
    let supportsPty: boolean | undefined;
    try {
      supportsPty = await ctx.sandboxManager.supportsInteractivePty?.();
    } catch (error) {
      console.warn("[agent-stream] PTY capability probe failed:", error);
      return hasExclusions
        ? (Object.keys(ctx.tools).filter(withoutExcludedTools) as Array<
            keyof typeof ctx.tools
          >)
        : undefined;
    }
    if (supportsPty !== false) {
      return hasExclusions
        ? (Object.keys(ctx.tools).filter(withoutExcludedTools) as Array<
            keyof typeof ctx.tools
          >)
        : undefined;
    }

    return Object.keys(ctx.tools).filter(
      (toolName) =>
        toolName !== "interact_terminal_session" &&
        withoutExcludedTools(toolName),
    ) as Array<keyof typeof ctx.tools>;
  };
  const getActiveTools = async (): Promise<
    Array<keyof typeof ctx.tools> | undefined
  > => getActiveToolsWithExclusions();
  const requestedLanguageModel = ctx.trackedProvider.languageModel(modelName);
  const requestedSlug = requestedLanguageModel.modelId;
  let lastRequestedSlug = requestedSlug;
  const assistantContentLoopMonitor = createAssistantContentLoopMonitor();
  const assistantContentLoopAbortController = new AbortController();
  const abortSignal = combineAbortSignals([
    ctx.abortController.signal,
    assistantContentLoopAbortController.signal,
  ]);
  const summarizationThreshold = getSummarizationThresholdTokens(
    getMaxTokensForSubscription(ctx.subscription, { mode: ctx.mode }),
  );
  let rollingContextCheckpoint: RollingModelContextCheckpoint | undefined;
  let compactionAttemptCount = 0;
  let lastCompactionRawMessageCount = -1;
  const canSummarizeAgain = () =>
    !ctx.temporary &&
    compactionAttemptCount < MAX_CONTEXT_COMPACTION_ATTEMPTS_PER_AGENT_STREAM;
  type AbortStepLike = {
    usage?: unknown;
    response?: Parameters<typeof extractOpenRouterMetadata>[0]["response"] & {
      modelId?: string;
    };
    providerMetadata?: unknown;
  };
  const recordAssistantContentLoopAbortState = (
    steps?: readonly AbortStepLike[],
  ) => {
    if (!state.stoppedDueToAssistantContentLoop) return;

    const lastStep = steps?.at(-1);
    state.streamFinishReason = DOOM_LOOP_FINISH_REASON;
    if (lastStep?.usage) {
      state.streamUsage = lastStep.usage as Record<string, unknown>;
    }
    state.responseModel = lastStep?.response?.modelId ?? state.responseModel;
    state.responseModel ??= lastRequestedSlug;

    const openRouterMetadata = lastStep
      ? extractOpenRouterMetadata({
          response: lastStep.response,
          providerMetadata: lastStep.providerMetadata,
        })
      : undefined;
    ctx.chatLogger?.setStreamResponse(
      state.responseModel,
      state.streamUsage,
      openRouterMetadata,
    );
  };

  type DoomLoopRecovery = {
    nudge?: string;
    excludedTools?: ReadonlySet<string>;
  };

  const getDoomLoopRecovery = (
    steps: unknown[],
    stepNumber: number,
  ): DoomLoopRecovery => {
    const loopCheck = detectDoomLoop(
      steps as Parameters<typeof detectDoomLoop>[0],
    );

    if (loopCheck.severity === "none") {
      return {};
    }

    console.log(
      `[doom-loop] severity=${loopCheck.severity} reason=${loopCheck.reason ?? "unknown"} tools=${loopCheck.toolNames.join(",")} count=${loopCheck.consecutiveCount} step=${stepNumber}`,
    );

    if (loopCheck.severity !== "warning") {
      return {};
    }

    const recovery: DoomLoopRecovery = {
      nudge: generateDoomLoopNudge(loopCheck),
    };
    console.log("[doom-loop] Injecting nudge as last user message");

    if (loopCheck.activeToolExclusions?.length) {
      recovery.excludedTools = new Set(loopCheck.activeToolExclusions);
      console.warn("[doom-loop] Applying active tool exclusions", {
        event: "doom_loop_tool_exclusion_recovery",
        chatId: ctx.chatId,
        modelName,
        requestedModel: requestedSlug,
        responseModel: state.responseModel,
        reason: loopCheck.reason,
        consecutiveCount: loopCheck.consecutiveCount,
        rawInput: {},
        excludedTools: loopCheck.activeToolExclusions,
      });
    }

    return recovery;
  };

  const getActiveToolsForRecovery = async (
    recovery: DoomLoopRecovery,
  ): Promise<Array<keyof typeof ctx.tools> | undefined> =>
    recovery.excludedTools && recovery.excludedTools.size > 0
      ? getActiveToolsWithExclusions(recovery.excludedTools)
      : getActiveTools();

  const initialActiveTools = await getActiveTools();
  const maxOutputTokens = MAX_OUTPUT_TOKENS;
  let streamHasImageViewResults = uiMessagesContainImageViewResult(
    state.finalMessages,
  );
  const getEffectiveModelName = () =>
    resolveAgentModelForImageToolResults(
      modelName,
      ctx.mode,
      streamHasImageViewResults,
    );
  const getEffectiveModelInfo = () => {
    const effectiveModelName = getEffectiveModelName();
    const languageModel = ctx.trackedProvider.languageModel(effectiveModelName);
    lastRequestedSlug = languageModel.modelId;
    return {
      modelName: effectiveModelName,
      languageModel,
      requestedSlug: languageModel.modelId,
    };
  };
  const getStepProviderOptions = (
    effectiveModelName = getEffectiveModelName(),
  ) =>
    buildProviderOptions(
      ctx.isReasoningModel,
      ctx.userId,
      effectiveModelName,
      ctx.mode,
      {
        hasMultimodalToolResults: streamHasImageViewResults,
        ...(ctx.providerReasoningOverride?.modelName === effectiveModelName && {
          reasoningOverride: ctx.providerReasoningOverride.reasoning,
        }),
      },
    );
  const prepareProviderMessages = (
    messages: ModelMessage[],
    effectiveModelName = getEffectiveModelName(),
  ): ModelMessage[] => {
    const nonEmptyMessages = filterEmptyAssistantMessages(messages);
    if (!isAnthropicModel(effectiveModelName)) return nonEmptyMessages;

    const repair = repairAnthropicModelMessagesWithTelemetry(nonEmptyMessages);
    if (repair.action !== "none") {
      ctx.chatLogger?.recordAnthropicPromptRepair({
        action: repair.action,
        reason: repair.reason,
        trailingAssistantContentTypes: repair.trailingAssistantContentTypes,
        model: effectiveModelName,
      });
    }
    return repair.messages as ModelMessage[];
  };
  let latestProviderRequestDiagnostics: ProviderRequestDiagnostics | undefined;
  const recordProviderRequestDiagnostics = (args: {
    modelName: string;
    requestedSlug?: string;
    stepIndex: number;
    source: ProviderRequestDiagnostics["source"];
    messages: ModelMessage[];
    providerOptions: unknown;
    activeTools: Array<keyof typeof ctx.tools> | undefined;
  }) => {
    latestProviderRequestDiagnostics = buildProviderRequestDiagnostics({
      modelName: args.modelName,
      requestedSlug: args.requestedSlug,
      stepIndex: args.stepIndex,
      source: args.source,
      messages: args.messages,
      providerOptions: args.providerOptions,
      activeTools: args.activeTools,
      availableToolCount: Object.keys(ctx.tools).length,
      contextUsage: state.ctxUsage,
      systemTokens: ctx.systemPromptTokens,
      maxOutputTokens,
      hasMultimodalToolResults: streamHasImageViewResults,
    });
    ctx.chatLogger?.recordProviderRequestDiagnostics(
      latestProviderRequestDiagnostics,
    );
    return latestProviderRequestDiagnostics;
  };
  const initialModelInfo = getEffectiveModelInfo();
  const initialProviderOptions = getStepProviderOptions(
    initialModelInfo.modelName,
  );
  const promptSerializationTools = createPromptSerializationTools(ctx.tools);
  const initialModelMessages = prepareProviderMessages(
    await convertToModelMessages(state.finalMessages, {
      tools: promptSerializationTools,
    }),
    initialModelInfo.modelName,
  );
  recordProviderRequestDiagnostics({
    modelName: initialModelInfo.modelName,
    requestedSlug: initialModelInfo.requestedSlug,
    stepIndex: 0,
    source: "initial",
    messages: initialModelMessages,
    providerOptions: initialProviderOptions,
    activeTools: initialActiveTools,
  });

  return streamText({
    model: initialModelInfo.languageModel,
    maxOutputTokens,
    system: buildSystemPrompt(
      ctx.currentSystemPrompt,
      initialModelInfo.modelName,
    ),
    messages: initialModelMessages,
    tools: ctx.tools,
    activeTools: initialActiveTools,
    abortSignal,
    providerOptions: initialProviderOptions,

    prepareStep: async ({ steps, messages }) => {
      const rawModelMessages = messages as ModelMessage[];
      let rollingModelMessages = buildRollingModelMessages(
        rawModelMessages,
        rollingContextCheckpoint,
      );
      try {
        const pruneResult = pruneToolOutputs(state.finalMessages);
        if (pruneResult.prunedCount > 0) {
          state.transcriptSourceMessages ??= state.finalMessages;
          state.finalMessages = pruneResult.messages;
        }

        const lastStep = Array.isArray(steps) ? steps.at(-1) : undefined;
        const toolResults =
          (lastStep && (lastStep as { toolResults?: unknown[] }).toolResults) ||
          [];
        if (toolResultsContainImageViewResult(toolResults)) {
          streamHasImageViewResults = true;
        }
        const effectiveModelInfo = getEffectiveModelInfo();

        const loopRecovery = getDoomLoopRecovery(steps, steps.length);
        const providerPromptPressure =
          getProviderPromptPressure(rollingModelMessages);
        const shouldCheckDurableSummary =
          ctx.summarizationTracker.summarizationCount === 0 &&
          steps.length === 0;
        const shouldCompactInRun =
          !shouldCheckDurableSummary &&
          (providerPromptPressure !== null ||
            state.lastStepInputTokens > summarizationThreshold);

        if (
          canSummarizeAgain() &&
          (shouldCheckDurableSummary || shouldCompactInRun)
        ) {
          if (shouldCheckDurableSummary) {
            const result = await runSummarizationStep({
              messages: state.finalMessages,
              modelMessages: rawModelMessages,
              subscription: ctx.subscription,
              languageModel: effectiveModelInfo.languageModel,
              mode: ctx.mode,
              writer: ctx.writer,
              chatId: ctx.chatId,
              fileTokens: ctx.fileTokens,
              todos: ctx.getTodoManager().getAllTodos(),
              abortSignal: ctx.abortController.signal,
              ensureSandbox: ctx.ensureSandbox,
              systemPromptTokens: ctx.systemPromptTokens,
              ctxSystemTokens: ctx.ctxSystemTokens,
              ctxMaxTokens: ctx.ctxMaxTokens,
              providerInputTokens: state.lastStepInputTokens,
              chatSystemPrompt: ctx.currentSystemPrompt,
              tools: ctx.tools,
              providerOptions: getStepProviderOptions(
                effectiveModelInfo.modelName,
              ),
              transcriptMessages: state.transcriptSourceMessages,
              providerPromptPressure,
            });

            if (result.summarizationAttempted) {
              compactionAttemptCount++;
              lastCompactionRawMessageCount = rawModelMessages.length;
            }

            if (result.needsSummarization && result.summarizedMessages) {
              ctx.summarizationTracker.recordSummarization(
                steps.length,
                result.summarizationUsage,
                ctx.usageTracker,
              );
              if (result.contextUsage) {
                state.ctxUsage = result.contextUsage;
              }
              state.finalMessages = result.summarizedMessages;
              state.transcriptSourceMessages = undefined;
              const activeTools = await getActiveToolsForRecovery(loopRecovery);
              const providerOptions = getStepProviderOptions(
                effectiveModelInfo.modelName,
              );
              let summarizedModelMessages = await convertToModelMessages(
                result.summarizedMessages,
                {
                  tools: createPromptSerializationTools(ctx.tools),
                },
              );
              state.postSummarizationContinuationActive = true;
              state.postSummarizationToolCallCount = 0;
              state.postSummarizationText = "";
              const continuationPrompt = loopRecovery.nudge
                ? `${POST_SUMMARIZATION_CONTINUATION_PROMPT}\n\n${loopRecovery.nudge}`
                : POST_SUMMARIZATION_CONTINUATION_PROMPT;
              summarizedModelMessages = [
                ...summarizedModelMessages,
                { role: "user", content: continuationPrompt },
              ];
              rollingContextCheckpoint = {
                baseMessages: summarizedModelMessages,
                rawMessageCursor: rawModelMessages.length,
              };
              const preparedMessages = prepareProviderMessages(
                summarizedModelMessages,
                effectiveModelInfo.modelName,
              );
              recordProviderRequestDiagnostics({
                modelName: effectiveModelInfo.modelName,
                requestedSlug: effectiveModelInfo.requestedSlug,
                stepIndex: steps.length + 1,
                source: "summarized_prepare_step",
                messages: preparedMessages,
                providerOptions,
                activeTools,
              });
              return {
                model: effectiveModelInfo.languageModel,
                activeTools,
                providerOptions,
                messages: preparedMessages,
              };
            }
          } else if (
            rawModelMessages.length === lastCompactionRawMessageCount
          ) {
            // Never repeatedly summarize the same raw source cursor. A later
            // provider step advances the cursor and can become eligible again.
          } else {
            compactionAttemptCount++;
            lastCompactionRawMessageCount = rawModelMessages.length;
            const inRunResult = await compactModelMessagesInRun({
              modelMessages: rollingModelMessages,
              transcriptModelMessages: rawModelMessages,
              subscription: ctx.subscription,
              languageModel: effectiveModelInfo.languageModel,
              mode: ctx.mode,
              writer: ctx.writer,
              chatId: ctx.chatId,
              todos: ctx.getTodoManager().getAllTodos(),
              abortSignal: ctx.abortController.signal,
              ensureSandbox: ctx.ensureSandbox,
              systemPromptTokens: ctx.systemPromptTokens,
              providerInputTokens: state.lastStepInputTokens,
              chatSystemPrompt: ctx.currentSystemPrompt,
              tools: ctx.tools,
              providerOptions: getStepProviderOptions(
                effectiveModelInfo.modelName,
              ),
              maxTokens: ctx.ctxMaxTokens,
              providerPromptPressure,
              compactionIndex: ctx.summarizationTracker.summarizationCount + 1,
              hasExistingSummary:
                ctx.summarizationTracker.hasSummarized ||
                state.finalMessages.some((message) =>
                  message.parts.some(
                    (part) =>
                      part.type === "text" &&
                      part.text.includes("<context_summary>"),
                  ),
                ),
            });

            if (!inRunResult) {
              // The helper clears its transient UI state. A later raw cursor
              // may retry while the bounded attempt budget remains.
            } else {
              const compactedModelMessages = await convertToModelMessages(
                [inRunResult.summaryMessage],
                { tools: createPromptSerializationTools(ctx.tools) },
              );
              const continuationPrompt = loopRecovery.nudge
                ? `${POST_SUMMARIZATION_CONTINUATION_PROMPT}\n\n${loopRecovery.nudge}`
                : POST_SUMMARIZATION_CONTINUATION_PROMPT;
              const lastStepResponseMessages =
                (
                  lastStep as
                    { response?: { messages?: ModelMessage[] } } | undefined
                )?.response?.messages ?? [];
              const retainedToolTransaction = getLatestCompletedToolTransaction(
                lastStepResponseMessages,
              );
              const nextBaseMessages: ModelMessage[] = [
                ...compactedModelMessages,
                ...retainedToolTransaction,
                { role: "user", content: continuationPrompt },
              ];
              const effectiveCompaction = isRollingCompactionEffective(
                rollingModelMessages,
                nextBaseMessages,
              );

              if (!effectiveCompaction) {
                ctx.summarizationTracker.recordSummarizationUsage(
                  inRunResult.summarizationUsage,
                  ctx.usageTracker,
                );
                writeSummarizationCleared(
                  ctx.writer,
                  ctx.summarizationTracker.summarizationCount + 1,
                );
                console.warn(
                  JSON.stringify({
                    level: "warn",
                    event: "agent_in_run_context_compaction_ineffective",
                    service: "chat-handler",
                    timestamp: new Date().toISOString(),
                    chat_id: ctx.chatId ?? undefined,
                    mode: ctx.mode,
                    compaction_attempt: compactionAttemptCount,
                    summarization_count:
                      ctx.summarizationTracker.summarizationCount,
                    raw_message_count: rawModelMessages.length,
                  }),
                );
              } else {
                ctx.summarizationTracker.recordSummarization(
                  steps.length,
                  inRunResult.summarizationUsage,
                  ctx.usageTracker,
                );
                writeSummarizationCompleted(
                  ctx.writer,
                  ctx.summarizationTracker.summarizationCount,
                );
                console.info(
                  JSON.stringify({
                    level: "info",
                    event: "agent_in_run_context_compaction_completed",
                    service: "chat-handler",
                    timestamp: new Date().toISOString(),
                    chat_id: ctx.chatId ?? undefined,
                    mode: ctx.mode,
                    subscription: ctx.subscription,
                    compaction_attempt: compactionAttemptCount,
                    summarization_count:
                      ctx.summarizationTracker.summarizationCount,
                    persistence: "run_scoped",
                    raw_message_count: rawModelMessages.length,
                    retained_tool_message_count: retainedToolTransaction.length,
                  }),
                );
                rollingContextCheckpoint = {
                  baseMessages: nextBaseMessages,
                  rawMessageCursor: rawModelMessages.length,
                };
                rollingModelMessages = nextBaseMessages;
                state.postSummarizationContinuationActive = true;
                state.postSummarizationToolCallCount = 0;
                state.postSummarizationText = "";

                const activeTools =
                  await getActiveToolsForRecovery(loopRecovery);
                const providerOptions = getStepProviderOptions(
                  effectiveModelInfo.modelName,
                );
                const preparedMessages = prepareProviderMessages(
                  nextBaseMessages,
                  effectiveModelInfo.modelName,
                );
                recordProviderRequestDiagnostics({
                  modelName: effectiveModelInfo.modelName,
                  requestedSlug: effectiveModelInfo.requestedSlug,
                  stepIndex: steps.length + 1,
                  source: "summarized_prepare_step",
                  messages: preparedMessages,
                  providerOptions,
                  activeTools,
                });
                return {
                  model: effectiveModelInfo.languageModel,
                  activeTools,
                  providerOptions,
                  messages: preparedMessages,
                };
              }
            }
          }
        }

        let currentMessages = rollingModelMessages as Array<
          Record<string, unknown>
        >;
        const modelPrune = pruneModelMessages(currentMessages);
        if (modelPrune.prunedCount > 0) {
          currentMessages = modelPrune.messages;
        }

        let updatedMessages = await applyPrepareStepReminders(currentMessages, {
          toolResults,
          noteInjectionOpts: ctx.noteInjectionOpts,
        });

        if (loopRecovery.nudge) {
          updatedMessages = [
            ...updatedMessages,
            { role: "user", content: loopRecovery.nudge },
          ] as typeof updatedMessages;
        }

        const activeTools = await getActiveToolsForRecovery(loopRecovery);
        const providerOptions = getStepProviderOptions(
          effectiveModelInfo.modelName,
        );
        const preparedMessages = prepareProviderMessages(
          addCacheBreakpointToLastUserMessage(
            updatedMessages,
            effectiveModelInfo.modelName,
          ) as ModelMessage[],
          effectiveModelInfo.modelName,
        ) as typeof messages;
        recordProviderRequestDiagnostics({
          modelName: effectiveModelInfo.modelName,
          requestedSlug: effectiveModelInfo.requestedSlug,
          stepIndex: steps.length + 1,
          source: "prepare_step",
          messages: preparedMessages as ModelMessage[],
          providerOptions,
          activeTools,
        });
        return {
          model: effectiveModelInfo.languageModel,
          activeTools,
          providerOptions,
          messages: preparedMessages,
        };
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          // Expected on user stop
        } else {
          console.error("[agent-stream] prepareStep error:", error);
        }
        const providerOptions = getStepProviderOptions();
        const fallbackMessages = prepareProviderMessages(
          rollingModelMessages,
        ) as typeof messages;
        return {
          providerOptions,
          messages: fallbackMessages,
          ...(ctx.currentSystemPrompt
            ? { system: ctx.currentSystemPrompt }
            : undefined),
        };
      }
    },

    stopWhen: [
      stepCountIs(getMaxStepsForUser(ctx.mode, ctx.subscription)),
      tokenExhaustedAfterSummarization({
        threshold: summarizationThreshold,
        getLastStepInputTokens: () => state.lastStepInputTokens,
        getHasSummarized: () =>
          ctx.summarizationTracker.hasSummarized || compactionAttemptCount > 0,
        getCanSummarizeAgain: canSummarizeAgain,
        onFired: () => {
          state.stoppedDueToTokenExhaustion = true;
        },
      }),
      elapsedTimeExceeds({
        maxDurationMs: ctx.maxDurationMs,
        getStartTime: () => ctx.streamStartTime,
        onFired: () => {
          state.stoppedDueToElapsedTimeout = true;
        },
      }),
      doomLoopDetected({
        onFired: () => {
          state.stoppedDueToDoomLoop = true;
        },
      }),
    ],

    onChunk: async (chunk) => {
      if (chunk.chunk.type === "text-delta") {
        if (state.postSummarizationContinuationActive) {
          state.postSummarizationText += chunk.chunk.text;
        }

        const loopDetection = assistantContentLoopMonitor.appendDelta(
          chunk.chunk.text,
        );
        if (
          loopDetection.detected &&
          !state.stoppedDueToAssistantContentLoop &&
          !ctx.abortController.signal.aborted
        ) {
          state.stoppedDueToAssistantContentLoop = true;
          state.assistantContentLoopDetection = loopDetection;
          console.warn("[agent-stream] assistant content loop detected", {
            event: "assistant_content_loop_detected",
            chatId: ctx.chatId,
            endpoint: ctx.endpoint,
            mode: ctx.mode,
            modelName,
            requestedModel: requestedSlug,
            responseModel: state.responseModel,
            reason: loopDetection.reason,
            repeatedText: loopDetection.repeatedText,
            repeatCount: loopDetection.repeatCount,
          });
          recordAssistantContentLoopAbortState();
          assistantContentLoopAbortController.abort();
        }
      }

      if (chunk.chunk.type === "tool-call") {
        if (state.postSummarizationContinuationActive) {
          state.postSummarizationToolCallCount++;
        }
        ctx.chatLogger?.recordToolCall(
          chunk.chunk.toolName,
          ctx.sandboxManager.getSandboxType(chunk.chunk.toolName),
        );
      }
    },

    onStepFinish: async ({ usage, response, providerMetadata }) => {
      let stepUsageCostIndex: number | undefined;
      if (usage) {
        stepUsageCostIndex = ctx.usageTracker.accumulateStep(
          usage as Parameters<typeof ctx.usageTracker.accumulateStep>[0],
        );
        state.lastStepInputTokens = usage.inputTokens || 0;
        if (usage.inputTokens) {
          state.ctxUsage = {
            ...state.ctxUsage,
            usedTokens: usage.inputTokens,
          };
        }
      }
      stepUsageCostIndexes.push(stepUsageCostIndex);

      const stepOpenRouterMetadata = extractOpenRouterMetadata({
        response,
        providerMetadata,
      });
      ctx.usageTracker.setAuthoritativeModelCostForStep(
        stepUsageCostIndex,
        stepOpenRouterMetadata.openrouter_upstream_inference_cost,
      );

      const currentCostDollars = ctx.usageTracker.computeCostDollars(modelName);
      const budgetDecision =
        ctx.budgetMonitor?.checkAfterStep(currentCostDollars);
      await ctx.settleUsageAfterStep?.({
        currentCostDollars,
        force:
          budgetDecision?.type === "abort" ||
          budgetDecision?.type === "abort-agent-run-spend-cap",
        model: response?.modelId ?? modelName,
      });
      if (budgetDecision?.type === "abort-agent-run-spend-cap") {
        state.stoppedDueToAgentRunSpendCap = true;
        ctx.abortController.abort();
      } else if (budgetDecision?.type === "abort") {
        state.stoppedDueToBudgetExhaustion = true;
        state.budgetAbortDetails = budgetDecision.details;
        ctx.abortController.abort();
        try {
          ctx.onBudgetAbort?.({ ...budgetDecision.details, model: modelName });
        } catch (error) {
          console.error("[agent-stream] onBudgetAbort failed:", error);
        }
      }
    },

    onFinish: async (finishResult) => {
      const { finishReason, usage, response } = finishResult;
      const hardReason = ctx.getHardTimeoutReason();
      if (
        hardReason === null &&
        state.postSummarizationContinuationActive &&
        isIncompletePostSummarizationStop({
          finishReason,
          text: state.postSummarizationText,
          toolCallCount: state.postSummarizationToolCallCount,
        })
      ) {
        state.stoppedDueToPostSummarizationIncomplete = true;
        console.warn("[agent-stream] post-summarization continuation stalled", {
          event: "post_summarization_continuation_incomplete",
          chatId: ctx.chatId,
          endpoint: ctx.endpoint,
          mode: ctx.mode,
          modelName,
          requestedModel: requestedSlug,
          textChars: state.postSummarizationText.length,
          toolCallCount: state.postSummarizationToolCallCount,
        });
      }
      if (hardReason !== null) {
        state.streamFinishReason = hardReason;
      } else if (state.stoppedDueToElapsedTimeout) {
        state.streamFinishReason = PREEMPTIVE_TIMEOUT_FINISH_REASON;
      } else if (state.stoppedDueToTokenExhaustion) {
        state.streamFinishReason = TOKEN_EXHAUSTION_FINISH_REASON;
      } else if (state.stoppedDueToDoomLoop) {
        state.streamFinishReason = DOOM_LOOP_FINISH_REASON;
      } else if (state.stoppedDueToAssistantContentLoop) {
        state.streamFinishReason = DOOM_LOOP_FINISH_REASON;
      } else if (state.stoppedDueToAgentRunSpendCap) {
        state.streamFinishReason = AGENT_RUN_SPEND_CAP_FINISH_REASON;
      } else if (state.stoppedDueToBudgetExhaustion) {
        state.streamFinishReason = BUDGET_EXHAUSTION_FINISH_REASON;
      } else if (state.stoppedDueToPostSummarizationIncomplete) {
        state.streamFinishReason = POST_SUMMARIZATION_INCOMPLETE_FINISH_REASON;
      } else {
        state.streamFinishReason = finishReason;
      }
      state.streamUsage = usage as Record<string, unknown>;
      state.responseModel = response?.modelId;

      const finishMetadata = finishResult as {
        providerMetadata?: unknown;
        steps?: Array<{
          response?: typeof response;
          providerMetadata?: unknown;
          usage?: { raw?: unknown };
        }>;
      };
      const stepOpenRouterMetadatas = Array.isArray(finishMetadata.steps)
        ? finishMetadata.steps.map((step) => {
            const metadata = extractOpenRouterMetadata({
              response: step.response,
              providerMetadata: step.providerMetadata,
            });
            return {
              ...metadata,
              openrouter_upstream_inference_cost:
                metadata.openrouter_upstream_inference_cost ??
                getOpenRouterUpstreamInferenceCostFromUsageRaw(step.usage?.raw),
            };
          })
        : [];
      for (const [index, metadata] of stepOpenRouterMetadatas.entries()) {
        ctx.usageTracker.setAuthoritativeModelCostForStep(
          stepUsageCostIndexes[index],
          metadata.openrouter_upstream_inference_cost,
        );
      }
      const finishOpenRouterMetadata = extractOpenRouterMetadata({
        response,
        providerMetadata: finishMetadata.providerMetadata,
      });
      const openRouterMetadata = mergeOpenRouterMetadata(
        finishOpenRouterMetadata,
        stepOpenRouterMetadatas.at(-1),
      );

      ctx.usageTracker.setAuthoritativeModelCostForStep(
        stepUsageCostIndexes.at(-1),
        openRouterMetadata.openrouter_upstream_inference_cost,
      );

      const fallbackSlugs = getFallbackSlugs(modelName, ctx.mode, {
        hasMultimodalToolResults: streamHasImageViewResults,
      });
      if (state.responseModel && fallbackSlugs.includes(state.responseModel)) {
        ctx.chatLogger?.recordModelFallback({
          requested: requestedSlug,
          served: state.responseModel,
          chain: fallbackSlugs,
          model: modelName,
        });
      }
      ctx.chatLogger?.setStreamResponse(
        state.responseModel,
        state.streamUsage,
        openRouterMetadata,
      );

      await ptySessionManager
        .closeAll(ctx.chatId)
        .catch((err) =>
          console.error("[agent-stream] PTY closeAll (onFinish) failed:", err),
        );
    },

    onError: async ({ error }) => {
      state.providerError = error;
      if (
        streamHasImageViewResults &&
        isProviderMultimodalToolResultRejectionError(error)
      ) {
        state.providerRejectedMultimodalToolResults = true;
      }
      const overflowKind = classifyProviderOverflowError(error);
      if (overflowKind) {
        state.stoppedDueToTokenExhaustion = true;
        state.streamFinishReason = TOKEN_EXHAUSTION_FINISH_REASON;
        console.warn("[agent-stream] provider overflow detected", {
          overflowKind,
          chatId: ctx.chatId,
          model: modelName,
          hadSummarization: ctx.summarizationTracker.hasSummarized,
        });
      }
      if (!isXaiSafetyError(error)) {
        const fallbackSlugs = getFallbackSlugs(modelName, ctx.mode, {
          hasMultimodalToolResults: streamHasImageViewResults,
        });
        ctx.chatLogger?.recordProviderError(error, {
          mode: ctx.mode,
          model: modelName,
          requestedModelSlug: requestedSlug,
          fallbackModelSlugs:
            fallbackSlugs.length > 0 ? fallbackSlugs : undefined,
          userId: ctx.userId,
          subscription: ctx.subscription,
          isTemporary: ctx.temporary,
          providerRequest: latestProviderRequestDiagnostics,
        });
      }
      if (!ctx.usageTracker.hasUsage) {
        await ctx.usageRefundTracker.refund();
      }
      await ptySessionManager
        .closeAll(ctx.chatId)
        .catch((err) =>
          console.error("[agent-stream] PTY closeAll (onError) failed:", err),
        );
    },

    onAbort: async ({ steps }) => {
      recordAssistantContentLoopAbortState(steps);
      await ptySessionManager
        .closeAll(ctx.chatId)
        .catch((err) =>
          console.error("[agent-stream] PTY closeAll (onAbort) failed:", err),
        );
    },
  });
}
