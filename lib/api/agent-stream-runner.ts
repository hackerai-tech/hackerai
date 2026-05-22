/**
 * Shared streamText factory for the agent loop.
 *
 * Both /api/agent (chat-handler.ts) and the trigger.dev agent-long task
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
  logOpenRouterFallbackIfFired,
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
import { ptySessionManager } from "@/lib/ai/tools/utils/pty-session-manager";
import { getMaxTokensForSubscription } from "@/lib/token-utils";
import { SUMMARIZATION_THRESHOLD_PERCENTAGE } from "@/lib/chat/summarization/constants";
import { getMaxStepsForUser } from "@/lib/chat/chat-processor";
import type { UsageTracker } from "@/lib/usage-tracker";
import type { BudgetMonitor } from "@/lib/chat/budget-monitor";
import type { UsageRefundTracker } from "@/lib/rate-limit";
import type { SummarizationTracker } from "@/lib/api/chat-stream-helpers";
import type { ChatLogger } from "@/lib/api/chat-logger";
import type { createTrackedProvider } from "@/lib/ai/providers";
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
  const requestedLanguageModel = ctx.trackedProvider.languageModel(modelName);
  const requestedSlug = requestedLanguageModel.modelId;
  const maxOutputTokens = ctx.subscription === "free" ? 4096 : 30000;
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

  return streamText({
    model: requestedLanguageModel,
    maxOutputTokens,
    system: buildSystemPrompt(ctx.currentSystemPrompt, modelName),
    messages: prepareProviderMessages(
      await convertToModelMessages(state.finalMessages),
    ),
    tools: ctx.tools,
    abortSignal: ctx.abortController.signal,
    providerOptions: buildProviderOptions(
      ctx.isReasoningModel,
      ctx.userId,
      modelName,
      ctx.mode,
    ),

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
            providerOptions: buildProviderOptions(
              ctx.isReasoningModel,
              ctx.userId,
              modelName,
              ctx.mode,
            ),
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
            return {
              messages: prepareProviderMessages(
                await convertToModelMessages(result.summarizedMessages),
              ),
            };
          }
        }

        let currentMessages = messages as Array<Record<string, unknown>>;
        const modelPrune = pruneModelMessages(currentMessages);
        if (modelPrune.prunedCount > 0) {
          currentMessages = modelPrune.messages;
        }

        const lastStep = Array.isArray(steps) ? steps.at(-1) : undefined;
        const toolResults =
          (lastStep && (lastStep as { toolResults?: unknown[] }).toolResults) ||
          [];

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

        return {
          messages: prepareProviderMessages(
            addCacheBreakpointToLastUserMessage(
              updatedMessages,
              modelName,
            ) as ModelMessage[],
          ) as typeof messages,
        };
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          // Expected on user stop
        } else {
          console.error("[agent-stream] prepareStep error:", error);
        }
        return ctx.currentSystemPrompt
          ? { system: ctx.currentSystemPrompt }
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

    onFinish: async ({ finishReason, usage, response }) => {
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

      const fallbackSlugs = getFallbackSlugs(modelName, ctx.mode);
      logOpenRouterFallbackIfFired({
        fallbackSlugs,
        requestedSlug,
        responseModel: state.responseModel,
        chatId: ctx.chatId,
      });
      if (state.responseModel && fallbackSlugs.includes(state.responseModel)) {
        ctx.chatLogger?.recordModelFallback({
          requested: requestedSlug,
          served: state.responseModel,
          chain: fallbackSlugs,
          model: modelName,
        });
      }
      ctx.chatLogger?.setStreamResponse(state.responseModel, state.streamUsage);

      await ptySessionManager
        .closeAll(ctx.chatId)
        .catch((err) =>
          console.error("[agent-stream] PTY closeAll (onFinish) failed:", err),
        );
    },

    onError: async ({ error }) => {
      state.providerError = error;
      if (!isXaiSafetyError(error)) {
        const fallbackSlugs = getFallbackSlugs(modelName, ctx.mode);
        ctx.chatLogger?.recordProviderError(error, {
          mode: ctx.mode,
          model: modelName,
          requestedModelSlug: requestedSlug,
          fallbackModelSlugs:
            fallbackSlugs.length > 0 ? fallbackSlugs : undefined,
          userId: ctx.userId,
          subscription: ctx.subscription,
          isTemporary: ctx.temporary,
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
