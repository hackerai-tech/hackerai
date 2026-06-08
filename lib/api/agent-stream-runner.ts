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
  writeContextUsage,
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
} from "@/lib/chat/stop-conditions";
import {
  detectDoomLoop,
  generateDoomLoopNudge,
} from "@/lib/chat/doom-loop-detection";
import {
  filterEmptyAssistantMessages,
  repairAnthropicModelMessagesWithTelemetry,
  pruneToolOutputs,
  pruneModelMessages,
} from "@/lib/chat/compaction/prune-tool-outputs";
import { isAnthropicModel } from "@/lib/ai/providers";
import {
  FREE_MAX_OUTPUT_TOKENS,
  PAID_MAX_OUTPUT_TOKENS,
} from "@/lib/rate-limit/free-config";
import { ptySessionManager } from "@/lib/ai/tools/utils/pty-session-manager";
import { getMaxTokensForSubscription } from "@/lib/token-utils";
import { SUMMARIZATION_THRESHOLD_PERCENTAGE } from "@/lib/chat/summarization/constants";
import { getMaxStepsForUser } from "@/lib/chat/chat-processor";
import {
  extractOpenRouterMetadata,
  fetchOpenRouterGenerationMetadata,
  mergeOpenRouterMetadata,
} from "@/lib/api/openrouter-metadata";
import type { UsageTracker } from "@/lib/usage-tracker";
import type { BudgetMonitor } from "@/lib/chat/budget-monitor";
import type { UsageRefundTracker } from "@/lib/rate-limit";
import type { SummarizationTracker } from "@/lib/api/chat-stream-helpers";
import type { ChatLogger } from "@/lib/api/chat-logger";
import type { createTrackedProvider } from "@/lib/ai/providers";
import type { ProviderRequestDiagnostics } from "@/lib/logger";
import type { ChatMode, SubscriptionTier } from "@/types";

// ---------------------------------------------------------------------------
// Mutable state — the runner updates these in place; callers read them back.
// ---------------------------------------------------------------------------

export type AgentStreamState = {
  /** Current UI messages fed into the model; updated each prepareStep. */
  finalMessages: UIMessage[];
  /** Context-window usage data; updated after summarization and each step. */
  ctxUsage: { usedTokens: number; maxTokens: number };
  lastStepInputTokens: number;
  /** Set in streamText.onFinish; read by the caller's toUIMessageStream.onFinish. */
  streamFinishReason: string | undefined;
  streamUsage: Record<string, unknown> | undefined;
  responseModel: string | undefined;
  /** Original provider/AI SDK error captured from streamText.onError. */
  providerError: unknown;
  /** Stop-condition flags set by the respective onFired callbacks. */
  stoppedDueToTokenExhaustion: boolean;
  /** Maps to stoppedDueToPreemptiveTimeout in chat-handler, stoppedDueToElapsedTimeout in agent-long. */
  stoppedDueToElapsedTimeout: boolean;
  stoppedDueToDoomLoop: boolean;
  stoppedDueToBudgetExhaustion: boolean;
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
    stoppedDueToTokenExhaustion: false,
    stoppedDueToElapsedTimeout: false,
    stoppedDueToDoomLoop: false,
    stoppedDueToBudgetExhaustion: false,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isImageViewOutput = (output: unknown): boolean => {
  if (!isRecord(output)) return false;

  return (
    output.action === "view" &&
    output.kind === "image" &&
    typeof output.mediaType === "string" &&
    output.mediaType.startsWith("image/")
  );
};

const uiMessagesContainImageViewResult = (messages: UIMessage[]): boolean =>
  messages.some((message) =>
    message.parts?.some((part) => {
      if (!isRecord(part) || part.type !== "tool-file") return false;
      return isImageViewOutput(part.output);
    }),
  );

const toolResultsContainImageViewResult = (toolResults: unknown[]): boolean =>
  toolResults.some((toolResult) => {
    if (!isRecord(toolResult) || toolResult.toolName !== "file") return false;
    return isImageViewOutput(toolResult.output);
  });

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
    | Record<string, unknown>
    | undefined;
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
  const getActiveTools = async (): Promise<
    Array<keyof typeof ctx.tools> | undefined
  > => {
    let supportsPty: boolean | undefined;
    try {
      supportsPty = await ctx.sandboxManager.supportsInteractivePty?.();
    } catch (error) {
      console.warn("[agent-stream] PTY capability probe failed:", error);
      return undefined;
    }
    if (supportsPty !== false) {
      return undefined;
    }

    return Object.keys(ctx.tools).filter(
      (toolName) => toolName !== "interact_terminal_session",
    ) as Array<keyof typeof ctx.tools>;
  };
  const initialActiveTools = await getActiveTools();
  const requestedLanguageModel = ctx.trackedProvider.languageModel(modelName);
  const requestedSlug = requestedLanguageModel.modelId;
  const maxOutputTokens =
    ctx.subscription === "free"
      ? FREE_MAX_OUTPUT_TOKENS
      : PAID_MAX_OUTPUT_TOKENS;
  let streamHasImageViewResults = uiMessagesContainImageViewResult(
    state.finalMessages,
  );
  const getStepProviderOptions = () =>
    buildProviderOptions(
      ctx.isReasoningModel,
      ctx.userId,
      modelName,
      ctx.mode,
      {
        hasMultimodalToolResults: streamHasImageViewResults,
      },
    );
  const prepareProviderMessages = (
    messages: ModelMessage[],
  ): ModelMessage[] => {
    const nonEmptyMessages = filterEmptyAssistantMessages(messages);
    if (!isAnthropicModel(modelName)) return nonEmptyMessages;

    const repair = repairAnthropicModelMessagesWithTelemetry(nonEmptyMessages);
    if (repair.action !== "none") {
      ctx.chatLogger?.recordAnthropicPromptRepair({
        action: repair.action,
        reason: repair.reason,
        trailingAssistantContentTypes: repair.trailingAssistantContentTypes,
        model: modelName,
      });
    }
    return repair.messages as ModelMessage[];
  };
  let latestProviderRequestDiagnostics: ProviderRequestDiagnostics | undefined;
  const recordProviderRequestDiagnostics = (args: {
    stepIndex: number;
    source: ProviderRequestDiagnostics["source"];
    messages: ModelMessage[];
    providerOptions: unknown;
    activeTools: Array<keyof typeof ctx.tools> | undefined;
  }) => {
    latestProviderRequestDiagnostics = buildProviderRequestDiagnostics({
      modelName,
      requestedSlug,
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
  const initialProviderOptions = getStepProviderOptions();
  const initialModelMessages = prepareProviderMessages(
    await convertToModelMessages(state.finalMessages, { tools: ctx.tools }),
  );
  recordProviderRequestDiagnostics({
    stepIndex: 0,
    source: "initial",
    messages: initialModelMessages,
    providerOptions: initialProviderOptions,
    activeTools: initialActiveTools,
  });

  return streamText({
    model: requestedLanguageModel,
    maxOutputTokens,
    system: buildSystemPrompt(ctx.currentSystemPrompt, modelName),
    messages: initialModelMessages,
    tools: ctx.tools,
    activeTools: initialActiveTools,
    abortSignal: ctx.abortController.signal,
    providerOptions: initialProviderOptions,

    prepareStep: async ({ steps, messages }) => {
      try {
        const threshold = Math.floor(
          getMaxTokensForSubscription(ctx.subscription, { mode: ctx.mode }) *
            SUMMARIZATION_THRESHOLD_PERCENTAGE,
        );

        const pruneResult = pruneToolOutputs(state.finalMessages);
        if (pruneResult.prunedCount > 0) {
          state.finalMessages = pruneResult.messages;
        }

        const lastStep = Array.isArray(steps) ? steps.at(-1) : undefined;
        const toolResults =
          (lastStep && (lastStep as { toolResults?: unknown[] }).toolResults) ||
          [];
        if (toolResultsContainImageViewResult(toolResults)) {
          streamHasImageViewResults = true;
        }

        if (!ctx.temporary && !ctx.summarizationTracker.hasSummarized) {
          const result = await runSummarizationStep({
            messages: state.finalMessages,
            modelMessages: messages,
            subscription: ctx.subscription,
            languageModel: ctx.trackedProvider.languageModel(modelName),
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
            providerOptions: getStepProviderOptions(),
          });

          if (result.needsSummarization && result.summarizedMessages) {
            ctx.summarizationTracker.recordSummarization(
              steps.length,
              result.summarizationUsage,
              ctx.usageTracker,
            );
            if (result.contextUsage) {
              state.ctxUsage = result.contextUsage;
            }
            const activeTools = await getActiveTools();
            const providerOptions = getStepProviderOptions();
            const preparedMessages = prepareProviderMessages(
              await convertToModelMessages(result.summarizedMessages, {
                tools: ctx.tools,
              }),
            );
            recordProviderRequestDiagnostics({
              stepIndex: steps.length + 1,
              source: "summarized_prepare_step",
              messages: preparedMessages,
              providerOptions,
              activeTools,
            });
            return {
              activeTools,
              providerOptions,
              messages: preparedMessages,
            };
          }
        }

        let currentMessages = messages as Array<Record<string, unknown>>;
        const modelPrune = pruneModelMessages(currentMessages);
        if (modelPrune.prunedCount > 0) {
          currentMessages = modelPrune.messages;
        }

        let updatedMessages = await applyPrepareStepReminders(currentMessages, {
          toolResults,
          noteInjectionOpts: ctx.noteInjectionOpts,
        });

        const loopCheck = detectDoomLoop(
          steps as unknown as Parameters<typeof detectDoomLoop>[0],
        );
        if (loopCheck.severity !== "none") {
          console.log(
            `[doom-loop] severity=${loopCheck.severity} tools=${loopCheck.toolNames.join(",")} count=${loopCheck.consecutiveCount} step=${steps.length}`,
          );
          if (loopCheck.severity === "warning") {
            const nudge = generateDoomLoopNudge(loopCheck);
            console.log("[doom-loop] Injecting nudge as last user message");
            updatedMessages = [
              ...updatedMessages,
              { role: "user", content: nudge },
            ] as typeof updatedMessages;
          }
        }

        const activeTools = await getActiveTools();
        const providerOptions = getStepProviderOptions();
        const preparedMessages = prepareProviderMessages(
          addCacheBreakpointToLastUserMessage(
            updatedMessages,
            modelName,
          ) as ModelMessage[],
        ) as typeof messages;
        recordProviderRequestDiagnostics({
          stepIndex: steps.length + 1,
          source: "prepare_step",
          messages: preparedMessages as ModelMessage[],
          providerOptions,
          activeTools,
        });
        return {
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
        return ctx.currentSystemPrompt
          ? {
              providerOptions: getStepProviderOptions(),
              system: ctx.currentSystemPrompt,
            }
          : {};
      }
    },

    stopWhen: [
      stepCountIs(getMaxStepsForUser(ctx.mode, ctx.subscription)),
      tokenExhaustedAfterSummarization({
        threshold: Math.floor(
          getMaxTokensForSubscription(ctx.subscription, { mode: ctx.mode }) *
            SUMMARIZATION_THRESHOLD_PERCENTAGE,
        ),
        getLastStepInputTokens: () => state.lastStepInputTokens,
        getHasSummarized: () => ctx.summarizationTracker.hasSummarized,
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
      if (chunk.chunk.type === "tool-call") {
        ctx.chatLogger?.recordToolCall(
          chunk.chunk.toolName,
          ctx.sandboxManager.getSandboxType(chunk.chunk.toolName),
        );
      }
    },

    onStepFinish: async ({ usage }) => {
      if (usage) {
        ctx.usageTracker.accumulateStep(
          usage as Parameters<typeof ctx.usageTracker.accumulateStep>[0],
        );
        state.lastStepInputTokens = usage.inputTokens || 0;

        if (ctx.contextUsageOn) {
          writeContextUsage(ctx.writer, {
            usedTokens:
              state.ctxUsage.usedTokens + ctx.usageTracker.streamOutputTokens,
            maxTokens: state.ctxUsage.maxTokens,
          });
        }
      }

      if (
        ctx.budgetMonitor?.checkAfterStep(
          ctx.usageTracker.computeCostDollars(modelName),
        ) === "abort"
      ) {
        state.stoppedDueToBudgetExhaustion = true;
        ctx.abortController.abort();
      }
    },

    onFinish: async (finishResult) => {
      const { finishReason, usage, response } = finishResult;
      const hardReason = ctx.getHardTimeoutReason();
      if (hardReason !== null) {
        state.streamFinishReason = hardReason;
      } else if (state.stoppedDueToElapsedTimeout) {
        state.streamFinishReason = PREEMPTIVE_TIMEOUT_FINISH_REASON;
      } else if (state.stoppedDueToTokenExhaustion) {
        state.streamFinishReason = TOKEN_EXHAUSTION_FINISH_REASON;
      } else if (state.stoppedDueToDoomLoop) {
        state.streamFinishReason = DOOM_LOOP_FINISH_REASON;
      } else if (state.stoppedDueToBudgetExhaustion) {
        state.streamFinishReason = BUDGET_EXHAUSTION_FINISH_REASON;
      } else {
        state.streamFinishReason = finishReason;
      }
      state.streamUsage = usage as Record<string, unknown>;
      state.responseModel = response?.modelId;

      const finishMetadata = finishResult as {
        providerMetadata?: unknown;
        steps?: Array<{ providerMetadata?: unknown }>;
      };
      const stepProviderMetadata = Array.isArray(finishMetadata.steps)
        ? finishMetadata.steps.at(-1)?.providerMetadata
        : undefined;
      const finishOpenRouterMetadata = extractOpenRouterMetadata({
        response,
        providerMetadata: finishMetadata.providerMetadata,
      });
      const stepOpenRouterMetadata = extractOpenRouterMetadata({
        providerMetadata: stepProviderMetadata,
      });
      let openRouterMetadata = mergeOpenRouterMetadata(
        finishOpenRouterMetadata,
        stepOpenRouterMetadata,
      );
      if (
        ctx.chatLogger &&
        !openRouterMetadata.provider_name &&
        openRouterMetadata.openrouter_generation_id
      ) {
        openRouterMetadata = mergeOpenRouterMetadata(
          openRouterMetadata,
          await fetchOpenRouterGenerationMetadata(
            openRouterMetadata.openrouter_generation_id,
          ),
        );
      }

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

    onAbort: async () => {
      await ptySessionManager
        .closeAll(ctx.chatId)
        .catch((err) =>
          console.error("[agent-stream] PTY closeAll (onAbort) failed:", err),
        );
    },
  });
}
