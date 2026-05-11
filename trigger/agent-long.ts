import { task, streams } from "@trigger.dev/sdk";
import {
  convertToModelMessages,
  createUIMessageStream,
  generateId,
  stepCountIs,
  streamText,
  UIMessage,
} from "ai";
import type { Geo } from "@vercel/functions";
import { countTokens } from "gpt-tokenizer";
import PostHogClient from "@/app/posthog";

import { systemPrompt } from "@/lib/system-prompt";
import { getResumeSection } from "@/lib/system-prompt/resume";
import { createTools } from "@/lib/ai/tools";
import { ptySessionManager } from "@/lib/ai/tools/utils/pty-session-manager";
import { generateTitleFromUserMessageWithWriter } from "@/lib/actions";
import { createTrackedProvider } from "@/lib/ai/providers";
import {
  processChatMessages,
  getMaxStepsForUser,
} from "@/lib/chat/chat-processor";
import {
  buildProviderOptions,
  buildSystemPrompt,
  injectNotesIntoMessages,
  addCacheBreakpointToLastUserMessage,
  applyPrepareStepReminders,
  sendRateLimitWarnings,
  runSummarizationStep,
  SummarizationTracker,
  appendSystemReminderToLastUserMessage,
  estimatePreflightInputTokens,
  buildExtraUsageConfig,
  computeContextUsage,
  writeContextUsage,
  isContextUsageEnabled,
  isProviderApiError,
  isXaiSafetyError,
  getFallbackSlugs,
  logOpenRouterFallbackIfFired,
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
  pruneToolOutputs,
  pruneModelMessages,
} from "@/lib/chat/compaction/prune-tool-outputs";
import {
  BudgetMonitor,
  captureBudgetSnapshot,
} from "@/lib/chat/budget-monitor";
import { UsageTracker } from "@/lib/usage-tracker";
import {
  checkRateLimit,
  deductUsage,
  UsageRefundTracker,
} from "@/lib/rate-limit";
import {
  saveMessage,
  updateChat,
  getUserCustomization,
  setActiveTriggerRun,
  getMessagesByChatId,
  prepareForNewStream,
} from "@/lib/db/actions";
import { getMaxTokensForSubscription } from "@/lib/token-utils";
import { SUMMARIZATION_THRESHOLD_PERCENTAGE } from "@/lib/chat/summarization/constants";
import { getBaseTodosForRequest } from "@/lib/utils/todo-utils";
import {
  writeAutoContinue,
  writeUploadStartStatus,
  writeUploadCompleteStatus,
} from "@/lib/utils/stream-writer-utils";
import {
  uploadSandboxFiles,
  getUploadBasePath,
} from "@/lib/utils/sandbox-file-utils";
import {
  captureToolCalls,
  createChatLogger,
  type ChatLogger,
} from "@/lib/api/chat-logger";
import { phLogger } from "@/lib/posthog/server";
import {
  extractErrorDetails,
  getUserFriendlyProviderError,
} from "@/lib/utils/error-utils";
import { ChatSDKError } from "@/lib/errors";
import type { Id } from "@/convex/_generated/dataModel";
import type {
  SubscriptionTier,
  Todo,
  SandboxPreference,
  SelectedModel,
  RateLimitInfo,
} from "@/types";

// Leave 2 min for cleanup before trigger.dev hits maxDuration: 60 * 60.
const AGENT_LONG_MAX_DURATION_MS = 58 * 60 * 1000;

// Shared between run() and onCancel() since onCancel is defined at task scope.
type RunCleanupState = {
  usageRefundTracker: UsageRefundTracker;
  chatLogger: ChatLogger | undefined;
  chatId: string;
};
const runCleanupMap = new Map<string, RunCleanupState>();

export type AgentLongPayload = {
  chatId: string;
  userId: string;
  subscription: SubscriptionTier;
  organizationId?: string;
  messages: UIMessage[];
  baseTodos: Todo[];
  sandboxPreference?: SandboxPreference;
  selectedModel?: SelectedModel;
  userLocation: Geo;
  temporary?: boolean;
  isAutoContinue?: boolean;
  regenerate?: boolean;
  isNewChat?: boolean;
};

export const agentLongTask = task({
  id: "agent-long",
  // Long agent runs may legitimately need an hour of tool calls.
  maxDuration: 60 * 60,

  onCancel: async ({
    ctx,
    runPromise,
  }: {
    ctx: { run: { id: string } };
    runPromise: Promise<unknown>;
  }) => {
    const state = runCleanupMap.get(ctx.run.id);
    if (!state) return;
    // Give the in-flight stream a brief grace window to flush cleanup.
    await Promise.race([runPromise, new Promise((r) => setTimeout(r, 5000))]);
    await state.usageRefundTracker.refund().catch(() => {});
    await ptySessionManager.closeAll(state.chatId).catch(() => {});
    await phLogger.flush().catch(() => {});
    runCleanupMap.delete(ctx.run.id);
  },

  run: async (payload: AgentLongPayload, { ctx, signal: triggerSignal }) => {
    const {
      chatId,
      userId,
      subscription,
      organizationId,
      messages,
      sandboxPreference,
      selectedModel: selectedModelOverride,
      userLocation,
      temporary,
      isAutoContinue,
      regenerate,
      isNewChat,
    } = payload;

    // Stable across retries so a failed-then-retried run upserts the same
    // message record rather than creating a duplicate.
    const assistantMessageId = ctx.run.id;
    const mode = "agent" as const; // Long mode reuses the agent loop verbatim.

    const usageRefundTracker = new UsageRefundTracker();
    usageRefundTracker.setUser(userId, subscription);

    let chatLogger: ChatLogger | undefined = createChatLogger({
      chatId,
      endpoint: "/api/agent",
    });
    chatLogger.setRequestDetails({
      mode,
      isTemporary: !!temporary,
      isRegenerate: !!regenerate,
    });
    chatLogger.setUser({
      id: userId,
      subscription,
      region: userLocation?.region,
    });

    // Register cleanup state so onCancel can reach it.
    runCleanupMap.set(ctx.run.id, { usageRefundTracker, chatLogger, chatId });

    try {
      const userCustomization = await getUserCustomization({ userId });

      // Re-fetch from DB so we have fileTokens for summarization.
      // The route already saved the user message; pass newMessages:[] to avoid duplicates.
      const fetched = await getMessagesByChatId({
        chatId,
        userId,
        subscription,
        newMessages: [],
        regenerate,
        isTemporary: temporary,
        mode,
      });
      const { chat, fileTokens } = fetched;

      const truncatedMessages = fetched.truncatedMessages;

      const baseTodos: Todo[] = getBaseTodosForRequest(
        (chat?.todos as unknown as Todo[]) || [],
        Array.isArray(payload.baseTodos) ? payload.baseTodos : [],
        { isTemporary: !!temporary, regenerate },
      );

      const uploadBasePath = getUploadBasePath(sandboxPreference);
      const { processedMessages, selectedModel, sandboxFiles } =
        await processChatMessages({
          messages: truncatedMessages.length ? truncatedMessages : messages,
          mode,
          subscription,
          uploadBasePath,
          modelOverride: selectedModelOverride,
        });

      if (!processedMessages.length) {
        throw new ChatSDKError(
          "bad_request:api",
          "Your message could not be processed. Please include some text with your file attachments and try again.",
        );
      }

      const memoryEnabled = userCustomization?.include_memory_entries ?? true;

      const estimatedInputTokens = await estimatePreflightInputTokens({
        mode,
        subscription,
        userId,
        selectedModel,
        userCustomization,
        temporary,
        truncatedMessages,
      });

      chatLogger.setChat(
        {
          messageCount: truncatedMessages.length,
          estimatedInputTokens,
          isNewChat: !!isNewChat,
          fileCount: 0,
          imageCount: 0,
          memoryEnabled,
        },
        selectedModel,
      );

      const extraUsageConfig = await buildExtraUsageConfig({
        userId,
        subscription,
        userCustomization,
      });

      const rateLimitInfo: RateLimitInfo = await checkRateLimit(
        userId,
        mode,
        subscription,
        estimatedInputTokens,
        extraUsageConfig,
        selectedModel,
        organizationId,
      );

      usageRefundTracker.recordDeductions(rateLimitInfo);
      chatLogger.setRateLimit(
        {
          pointsDeducted: rateLimitInfo.pointsDeducted,
          extraUsagePointsDeducted: rateLimitInfo.extraUsagePointsDeducted,
          monthly: rateLimitInfo.monthly,
          remaining: rateLimitInfo.remaining,
          subscription,
        },
        extraUsageConfig,
      );

      const posthog = PostHogClient();
      chatLogger.getBuilder().setAssistantId(assistantMessageId);

      // Wire trigger.dev's abort signal into a local controller.
      // Fires on runs.cancel() (UI Stop) and maxDuration exceeded.
      const userStopSignal = new AbortController();
      triggerSignal.addEventListener("abort", () => userStopSignal.abort(), {
        once: true,
      });

      const summarizationTracker = new SummarizationTracker();
      chatLogger.startStream();

      const uiStream = createUIMessageStream({
        onError: (error) => {
          if (error instanceof ChatSDKError) {
            return typeof error.cause === "string"
              ? error.cause
              : error.message;
          }
          return getUserFriendlyProviderError(error);
        },
        execute: async ({ writer }) => {
          sendRateLimitWarnings(writer, { subscription, mode, rateLimitInfo });

          const {
            tools,
            ensureSandbox,
            getTodoManager,
            getFileAccumulator,
            sandboxManager,
            getSandboxSessionCost,
          } = createTools(
            userId,
            chatId,
            writer,
            mode,
            userLocation,
            baseTodos,
            memoryEnabled,
            !!temporary,
            assistantMessageId,
            sandboxPreference,
            process.env.CONVEX_SERVICE_ROLE_KEY,
            userCustomization?.guardrails_config,
            false,
            undefined,
            undefined,
            (costDollars: number) => {
              usageTracker.providerCost += costDollars;
              usageTracker.nonModelCost += costDollars;
              chatLogger?.getBuilder().addToolCost(costDollars);
            },
            subscription,
            (info) => chatLogger?.setSandboxBoot(info),
            undefined,
          );

          const sendFileMetadataToStream = (
            fileMetadata: Array<{
              fileId: Id<"files">;
              name: string;
              mediaType: string;
              s3Key?: string;
              storageId?: Id<"_storage">;
            }>,
          ) => {
            if (!fileMetadata || fileMetadata.length === 0) return;
            writer.write({
              type: "data-file-metadata",
              data: {
                messageId: assistantMessageId,
                fileDetails: fileMetadata,
              },
            });
          };

          let sandboxContext: string | null = null;
          if ("getSandboxContextForPrompt" in sandboxManager) {
            try {
              sandboxContext = await (
                sandboxManager as {
                  getSandboxContextForPrompt: () => Promise<string | null>;
                }
              ).getSandboxContextForPrompt();
            } catch (err) {
              console.warn("[agent-long] Failed to get sandbox context:", err);
            }
          }

          if (sandboxFiles && sandboxFiles.length > 0) {
            writeUploadStartStatus(writer);
            let uploadResult: { failedCount: number } = { failedCount: 0 };
            try {
              uploadResult = await uploadSandboxFiles(
                sandboxFiles,
                ensureSandbox,
              );
            } finally {
              writeUploadCompleteStatus(writer);
            }
            if (uploadResult.failedCount > 0) {
              const noun =
                uploadResult.failedCount === 1 ? "attachment" : "attachments";
              const uploadError = new ChatSDKError(
                "bad_request:stream",
                `Failed to upload ${uploadResult.failedCount} ${noun} to the computer. Please try again.`,
              );
              await usageRefundTracker.refund();
              chatLogger?.emitChatError(uploadError);
              throw uploadError;
            }
          }

          const titlePromise =
            isNewChat && !temporary
              ? generateTitleFromUserMessageWithWriter(
                  processedMessages,
                  writer,
                )
              : Promise.resolve(undefined);

          const trackedProvider = createTrackedProvider();
          const currentSystemPrompt = await systemPrompt(
            userId,
            mode,
            subscription,
            selectedModel,
            userCustomization,
            temporary,
            sandboxContext,
          );
          const systemPromptTokens = countTokens(currentSystemPrompt);

          const contextUsageOn = isContextUsageEnabled(subscription, mode);
          const ctxSystemTokens = contextUsageOn ? systemPromptTokens : 0;
          const ctxMaxTokens = contextUsageOn
            ? getMaxTokensForSubscription(subscription, { mode })
            : 0;
          let ctxUsage = contextUsageOn
            ? computeContextUsage(
                truncatedMessages,
                fileTokens,
                ctxSystemTokens,
                ctxMaxTokens,
              )
            : { usedTokens: 0, maxTokens: 0 };

          let streamFinishReason: string | undefined;
          let finalMessages = processedMessages;

          const resumeContext = getResumeSection(chat?.finish_reason);
          if (resumeContext) {
            finalMessages = appendSystemReminderToLastUserMessage(
              finalMessages,
              resumeContext,
            );
          }

          const noteInjectionOpts = {
            userId,
            subscription,
            shouldIncludeNotes:
              userCustomization?.include_memory_entries ?? true,
            isTemporary: !!temporary,
          };
          finalMessages = await injectNotesIntoMessages(
            finalMessages,
            noteInjectionOpts,
          );

          const hasSummarized = () => summarizationTracker.hasSummarized;

          let stoppedDueToTokenExhaustion = false;
          let stoppedDueToElapsedTimeout = false;
          let stoppedDueToDoomLoop = false;
          let stoppedDueToBudgetExhaustion = false;
          let lastStepInputTokens = 0;

          const budgetSnapshot = captureBudgetSnapshot({
            rateLimitInfo,
            extraUsageConfig,
            subscription,
          });
          const budgetMonitor = budgetSnapshot
            ? new BudgetMonitor(budgetSnapshot, writer, subscription)
            : null;

          const streamStartTime = Date.now();
          const configuredModelId =
            trackedProvider.languageModel(selectedModel).modelId;

          let streamUsage: Record<string, unknown> | undefined;
          let responseModel: string | undefined;
          let isRetryWithFallback = false;
          const isAutoModel = [
            "ask-model",
            "ask-model-free",
            "agent-model",
            "agent-model-free",
          ].includes(selectedModel);
          const fallbackModel = "fallback-agent-model";

          const usageTracker = new UsageTracker();
          let hasDeductedUsage = false;
          let preFallbackCacheRead = 0;
          let preFallbackCacheWrite = 0;

          const deductAccumulatedUsage = async () => {
            if (hasDeductedUsage || subscription === "free") return;
            const sandboxCost = getSandboxSessionCost();
            if (sandboxCost > 0) {
              usageTracker.providerCost += sandboxCost;
              usageTracker.nonModelCost += sandboxCost;
              chatLogger?.getBuilder().addToolCost(sandboxCost);
            }
            if (!usageTracker.hasUsage) return;
            hasDeductedUsage = true;
            const providerCost =
              usageTracker.modelProviderCost > 0
                ? usageTracker.providerCost
                : undefined;
            await deductUsage(
              userId,
              subscription,
              estimatedInputTokens,
              usageTracker.inputTokens,
              usageTracker.outputTokens,
              extraUsageConfig,
              providerCost,
              selectedModel,
              usageTracker.nonModelCost,
            );
            usageTracker.log({
              userId,
              selectedModel,
              selectedModelOverride,
              responseModel,
              configuredModelId,
              rateLimitInfo,
            });
          };

          const createStream = async (modelName: string) => {
            const requestedLanguageModel =
              trackedProvider.languageModel(modelName);
            const requestedSlug = requestedLanguageModel.modelId;
            return streamText({
              model: requestedLanguageModel,
              maxOutputTokens: 30000,
              system: buildSystemPrompt(currentSystemPrompt, modelName),
              messages: filterEmptyAssistantMessages(
                await convertToModelMessages(finalMessages),
              ),
              tools,
              abortSignal: userStopSignal.signal,
              providerOptions: buildProviderOptions(true, userId, modelName),
              prepareStep: async ({ steps, messages: stepMessages }) => {
                try {
                  const threshold = Math.floor(
                    getMaxTokensForSubscription(subscription, { mode }) *
                      SUMMARIZATION_THRESHOLD_PERCENTAGE,
                  );

                  const pruneResult = pruneToolOutputs(finalMessages);
                  if (pruneResult.prunedCount > 0) {
                    finalMessages = pruneResult.messages;
                  }

                  if (!temporary && !hasSummarized()) {
                    const result = await runSummarizationStep({
                      messages: finalMessages,
                      modelMessages: stepMessages,
                      subscription,
                      languageModel: trackedProvider.languageModel(modelName),
                      mode,
                      writer,
                      chatId,
                      fileTokens,
                      todos: getTodoManager().getAllTodos(),
                      abortSignal: userStopSignal.signal,
                      ensureSandbox,
                      systemPromptTokens,
                      ctxSystemTokens,
                      ctxMaxTokens,
                      providerInputTokens: lastStepInputTokens,
                      chatSystemPrompt: currentSystemPrompt,
                      tools,
                      providerOptions: buildProviderOptions(
                        true,
                        userId,
                        modelName,
                      ),
                    });

                    if (
                      result.needsSummarization &&
                      result.summarizedMessages
                    ) {
                      summarizationTracker.recordSummarization(
                        steps.length,
                        result.summarizationUsage,
                        usageTracker,
                      );
                      if (result.contextUsage) {
                        ctxUsage = result.contextUsage;
                      }
                      return {
                        messages: filterEmptyAssistantMessages(
                          await convertToModelMessages(
                            result.summarizedMessages,
                          ),
                        ),
                      };
                    }
                  }

                  let currentMessages = stepMessages as Array<
                    Record<string, unknown>
                  >;
                  const modelPrune = pruneModelMessages(currentMessages);
                  if (modelPrune.prunedCount > 0) {
                    currentMessages = modelPrune.messages;
                  }

                  const lastStep = Array.isArray(steps)
                    ? steps.at(-1)
                    : undefined;
                  const toolResults =
                    (lastStep &&
                      (lastStep as { toolResults?: unknown[] }).toolResults) ||
                    [];

                  let updatedMessages = await applyPrepareStepReminders(
                    currentMessages,
                    {
                      toolResults,
                      noteInjectionOpts,
                    },
                  );

                  const loopCheck = detectDoomLoop(
                    steps as unknown as Parameters<typeof detectDoomLoop>[0],
                  );
                  if (loopCheck.severity !== "none") {
                    if (loopCheck.severity === "warning") {
                      const nudge = generateDoomLoopNudge(loopCheck);
                      updatedMessages = [
                        ...updatedMessages,
                        { role: "user", content: nudge },
                      ] as typeof updatedMessages;
                    }
                  }

                  return {
                    messages: filterEmptyAssistantMessages(
                      addCacheBreakpointToLastUserMessage(
                        updatedMessages,
                        modelName,
                      ),
                    ) as typeof stepMessages,
                  };
                } catch (error) {
                  if (
                    error instanceof DOMException &&
                    error.name === "AbortError"
                  ) {
                    // Expected when user stops the stream
                  } else {
                    console.error("[agent-long] prepareStep error:", error);
                  }
                  return currentSystemPrompt
                    ? { system: currentSystemPrompt }
                    : {};
                }
              },
              stopWhen: [
                stepCountIs(getMaxStepsForUser(mode, subscription)),
                tokenExhaustedAfterSummarization({
                  threshold: Math.floor(
                    getMaxTokensForSubscription(subscription, { mode }) *
                      SUMMARIZATION_THRESHOLD_PERCENTAGE,
                  ),
                  getLastStepInputTokens: () => lastStepInputTokens,
                  getHasSummarized: hasSummarized,
                  onFired: () => {
                    stoppedDueToTokenExhaustion = true;
                  },
                }),
                elapsedTimeExceeds({
                  maxDurationMs: AGENT_LONG_MAX_DURATION_MS,
                  getStartTime: () => streamStartTime,
                  onFired: () => {
                    stoppedDueToElapsedTimeout = true;
                  },
                }),
                doomLoopDetected({
                  onFired: () => {
                    stoppedDueToDoomLoop = true;
                  },
                }),
              ],
              onChunk: async (chunk) => {
                if (chunk.chunk.type === "tool-call") {
                  chatLogger?.recordToolCall(
                    chunk.chunk.toolName,
                    sandboxManager.getSandboxType(chunk.chunk.toolName),
                  );
                }
              },
              onStepFinish: async ({ usage }) => {
                if (usage) {
                  usageTracker.accumulateStep(
                    usage as Parameters<typeof usageTracker.accumulateStep>[0],
                  );
                  lastStepInputTokens = usage.inputTokens || 0;
                  if (contextUsageOn) {
                    writeContextUsage(writer, {
                      usedTokens:
                        ctxUsage.usedTokens + usageTracker.streamOutputTokens,
                      maxTokens: ctxUsage.maxTokens,
                    });
                  }
                }
                if (
                  budgetMonitor?.checkAfterStep(
                    usageTracker.computeCostDollars(modelName),
                  ) === "abort"
                ) {
                  stoppedDueToBudgetExhaustion = true;
                  userStopSignal.abort();
                }
              },
              onFinish: async ({ finishReason, usage, response }) => {
                if (stoppedDueToElapsedTimeout) {
                  streamFinishReason = PREEMPTIVE_TIMEOUT_FINISH_REASON;
                } else if (stoppedDueToTokenExhaustion) {
                  streamFinishReason = TOKEN_EXHAUSTION_FINISH_REASON;
                } else if (stoppedDueToDoomLoop) {
                  streamFinishReason = DOOM_LOOP_FINISH_REASON;
                } else if (stoppedDueToBudgetExhaustion) {
                  streamFinishReason = BUDGET_EXHAUSTION_FINISH_REASON;
                } else {
                  streamFinishReason = finishReason;
                }
                streamUsage = usage as Record<string, unknown>;
                responseModel = response?.modelId;

                logOpenRouterFallbackIfFired({
                  fallbackSlugs: getFallbackSlugs(modelName),
                  requestedSlug,
                  responseModel,
                  chatId,
                });
                chatLogger?.setStreamResponse(responseModel, streamUsage);

                await ptySessionManager
                  .closeAll(chatId)
                  .catch((err) =>
                    console.error(
                      "[agent-long] PTY closeAll (onFinish) failed:",
                      err,
                    ),
                  );
              },
              onError: async ({ error }) => {
                if (!isXaiSafetyError(error)) {
                  chatLogger?.recordProviderError(error, {
                    mode,
                    model: selectedModel,
                    userId,
                    subscription,
                    isTemporary: temporary,
                  });
                }
                if (!usageTracker.hasUsage) {
                  await usageRefundTracker.refund();
                }
                await ptySessionManager
                  .closeAll(chatId)
                  .catch((err) =>
                    console.error(
                      "[agent-long] PTY closeAll (onError) failed:",
                      err,
                    ),
                  );
              },
              onAbort: async () => {
                await ptySessionManager
                  .closeAll(chatId)
                  .catch((err) =>
                    console.error(
                      "[agent-long] PTY closeAll (onAbort) failed:",
                      err,
                    ),
                  );
              },
            });
          };

          let result;
          try {
            result = await createStream(selectedModel);
          } catch (error) {
            if (
              isProviderApiError(error) &&
              !isRetryWithFallback &&
              isAutoModel
            ) {
              phLogger.error(
                "[agent-long] Provider API error, retrying with fallback",
                {
                  error,
                  chatId,
                  originalModel: selectedModel,
                  fallbackModel,
                  userId,
                  subscription,
                  preFallbackCacheReadTokens: usageTracker.cacheReadTokens,
                  preFallbackCacheWriteTokens: usageTracker.cacheWriteTokens,
                  ...extractErrorDetails(error),
                },
              );
              isRetryWithFallback = true;
              lastStepInputTokens = 0;
              stoppedDueToTokenExhaustion = false;
              stoppedDueToElapsedTimeout = false;
              stoppedDueToDoomLoop = false;
              stoppedDueToBudgetExhaustion = false;
              preFallbackCacheRead = usageTracker.cacheReadTokens;
              preFallbackCacheWrite = usageTracker.cacheWriteTokens;
              usageTracker.resetModelLeg();
              result = await createStream(fallbackModel);
            } else {
              throw error;
            }
          }

          writer.merge(
            result.toUIMessageStream({
              generateMessageId: () => assistantMessageId,
              sendReasoning: true,
              onFinish: async ({ messages: finishedMessages, isAborted }) => {
                console.log("[agent-long] onFinish start", {
                  chatId,
                  isAborted,
                  messageCount: finishedMessages.length,
                  streamFinishReason,
                  stoppedDueToTokenExhaustion,
                  stoppedDueToElapsedTimeout,
                  stoppedDueToDoomLoop,
                  stoppedDueToBudgetExhaustion,
                });
                try {
                  // Retry with fallback if stream only produced step-start (incomplete response)
                  const lastAssistantMessage = finishedMessages
                    .slice()
                    .reverse()
                    .find((m) => m.role === "assistant");
                  const hasOnlyStepStart =
                    lastAssistantMessage?.parts?.length === 1 &&
                    lastAssistantMessage.parts[0]?.type === "step-start";

                  if (
                    hasOnlyStepStart &&
                    !isRetryWithFallback &&
                    !isAborted &&
                    isAutoModel
                  ) {
                    isRetryWithFallback = true;
                    lastStepInputTokens = 0;
                    stoppedDueToTokenExhaustion = false;
                    stoppedDueToElapsedTimeout = false;
                    stoppedDueToDoomLoop = false;
                    stoppedDueToBudgetExhaustion = false;
                    const fallbackStartTime = Date.now();
                    usageTracker.resetModelLeg();
                    const retryResult = await createStream(fallbackModel);
                    const retryMessageId = generateId();

                    writer.merge(
                      retryResult.toUIMessageStream({
                        generateMessageId: () => retryMessageId,
                        sendReasoning: true,
                        onFinish: async ({
                          messages: retryMessages,
                          isAborted: retryAborted,
                        }) => {
                          const fallbackCacheRead =
                            usageTracker.cacheReadTokens - preFallbackCacheRead;
                          const fallbackCacheWrite =
                            usageTracker.cacheWriteTokens -
                            preFallbackCacheWrite;
                          const fallbackCacheTotal =
                            fallbackCacheRead + fallbackCacheWrite;
                          chatLogger?.setSandbox(
                            sandboxManager.getSandboxInfo(),
                          );
                          chatLogger?.setCacheMetrics({
                            cacheHitRate:
                              fallbackCacheTotal > 0
                                ? fallbackCacheRead / fallbackCacheTotal
                                : null,
                            cacheReadTokens: fallbackCacheRead,
                            cacheWriteTokens: fallbackCacheWrite,
                          });
                          captureToolCalls({
                            posthog,
                            chatLogger,
                            userId,
                            mode,
                          });
                          posthog?.shutdown();
                          chatLogger?.emitSuccess({
                            finishReason: streamFinishReason,
                            wasAborted: retryAborted,
                            wasPreemptiveTimeout: false,
                            hadSummarization: hasSummarized(),
                          });

                          const generatedTitle = await titlePromise;
                          if (!temporary) {
                            const mergedTodos = getTodoManager().mergeWith(
                              baseTodos,
                              retryMessageId,
                            );
                            if (
                              generatedTitle ||
                              streamFinishReason ||
                              mergedTodos.length > 0
                            ) {
                              await updateChat({
                                chatId,
                                title: generatedTitle,
                                finishReason: streamFinishReason,
                                todos: mergedTodos,
                                defaultModelSlug: "agent-long",
                                sandboxType:
                                  sandboxManager.getEffectivePreference(),
                                selectedModel: selectedModelOverride,
                              });
                            } else {
                              await prepareForNewStream({ chatId });
                            }
                            const accumulatedFiles =
                              getFileAccumulator().getAll();
                            const newFileIds = accumulatedFiles.map(
                              (f) => f.fileId,
                            );
                            for (const msg of retryMessages) {
                              if (msg.role !== "assistant") continue;
                              const processed =
                                summarizationTracker.processMessageForSave(msg);
                              await saveMessage({
                                chatId,
                                userId,
                                message: processed,
                                extraFileIds: newFileIds,
                                usage: streamUsage,
                                model: responseModel,
                                generationTimeMs:
                                  Date.now() - fallbackStartTime,
                                finishReason: streamFinishReason,
                              });
                            }
                            sendFileMetadataToStream(accumulatedFiles);
                          }
                          await deductAccumulatedUsage();
                        },
                      }),
                    );
                    return;
                  }

                  // User-initiated abort via trigger.dev cancel: clear finish reason
                  // so the client doesn't show spurious "going off course" messages.
                  if (
                    isAborted &&
                    triggerSignal.aborted &&
                    !stoppedDueToBudgetExhaustion &&
                    !stoppedDueToElapsedTimeout
                  ) {
                    streamFinishReason = undefined;
                  }

                  console.log("[agent-long] onFinish: emitting telemetry", {
                    chatId,
                  });
                  chatLogger?.setSandbox(sandboxManager.getSandboxInfo());
                  chatLogger?.setCacheMetrics({
                    cacheHitRate: usageTracker.cacheHitRate,
                    cacheReadTokens: usageTracker.cacheReadTokens,
                    cacheWriteTokens: usageTracker.cacheWriteTokens,
                  });
                  captureToolCalls({ posthog, chatLogger, userId, mode });
                  posthog?.shutdown();
                  chatLogger?.emitSuccess({
                    finishReason: streamFinishReason,
                    wasAborted: isAborted,
                    wasPreemptiveTimeout: stoppedDueToElapsedTimeout,
                    hadSummarization: hasSummarized(),
                  });

                  console.log("[agent-long] onFinish: awaiting title", {
                    chatId,
                  });
                  const generatedTitle = await titlePromise;
                  console.log(
                    "[agent-long] onFinish: title done, calling updateChat/saveMessage",
                    {
                      chatId,
                      temporary,
                      generatedTitle,
                      streamFinishReason,
                    },
                  );

                  if (!temporary) {
                    const mergedTodos = getTodoManager().mergeWith(
                      baseTodos,
                      assistantMessageId,
                    );
                    const shouldPersist = regenerate
                      ? true
                      : Boolean(
                          generatedTitle ||
                          streamFinishReason ||
                          mergedTodos.length > 0,
                        );

                    if (shouldPersist) {
                      await updateChat({
                        chatId,
                        title: generatedTitle,
                        finishReason: streamFinishReason,
                        todos: mergedTodos,
                        defaultModelSlug: "agent-long",
                        sandboxType: sandboxManager.getEffectivePreference(),
                        selectedModel: selectedModelOverride,
                      });
                    } else {
                      await prepareForNewStream({ chatId });
                    }

                    const accumulatedFiles = getFileAccumulator().getAll();
                    const newFileIds = accumulatedFiles.map((f) => f.fileId);

                    let resolvedUsage: Record<string, unknown> | undefined =
                      streamUsage;
                    if (!resolvedUsage && isAborted) {
                      try {
                        resolvedUsage = (await result.usage) as Record<
                          string,
                          unknown
                        >;
                      } catch {
                        // Usage unavailable on abort
                      }
                    }

                    // On abort with no files/tools/usage, skip message save (per plan caveat:
                    // no shouldSkipSave() equivalent — check for empty content instead).
                    const hasIncompleteToolCalls = finishedMessages.some(
                      (msg) =>
                        msg.role === "assistant" &&
                        msg.parts?.some(
                          (p: {
                            type?: string;
                            state?: string;
                            toolCallId?: string;
                          }) =>
                            p.type?.startsWith("tool-") &&
                            p.state !== "output-available" &&
                            p.toolCallId,
                        ),
                    );
                    if (
                      isAborted &&
                      !triggerSignal.aborted && // don't skip on trigger-initiated cancel
                      newFileIds.length === 0 &&
                      !hasIncompleteToolCalls &&
                      !resolvedUsage
                    ) {
                      await deductAccumulatedUsage();
                      return;
                    }

                    console.log("[agent-long] onFinish: saving messages", {
                      chatId,
                      messageCount: finishedMessages.length,
                      roles: finishedMessages.map((m) => m.role),
                      newFileIds: newFileIds.length,
                    });
                    for (const message of finishedMessages) {
                      const processed =
                        summarizationTracker.processMessageForSave(message);
                      if (
                        (!processed.parts || processed.parts.length === 0) &&
                        newFileIds.length === 0
                      ) {
                        continue;
                      }
                      await saveMessage({
                        chatId,
                        userId,
                        message: processed,
                        extraFileIds: newFileIds,
                        model: responseModel || configuredModelId,
                        generationTimeMs: Date.now() - streamStartTime,
                        finishReason: streamFinishReason,
                        usage: resolvedUsage ?? streamUsage,
                        updateOnly:
                          isAborted && !stoppedDueToElapsedTimeout
                            ? true
                            : undefined,
                        isHidden:
                          isAutoContinue && processed.role === "user"
                            ? true
                            : undefined,
                      });
                    }

                    sendFileMetadataToStream(accumulatedFiles);
                  }

                  if (contextUsageOn) {
                    writeContextUsage(writer, {
                      usedTokens:
                        ctxUsage.usedTokens + usageTracker.streamOutputTokens,
                      maxTokens: ctxUsage.maxTokens,
                    });
                  }

                  if (
                    (stoppedDueToTokenExhaustion ||
                      stoppedDueToElapsedTimeout ||
                      streamFinishReason === "tool-calls") &&
                    !temporary
                  ) {
                    writeAutoContinue(writer);
                  }

                  await deductAccumulatedUsage();
                  console.log("[agent-long] onFinish complete", { chatId });
                } catch (onFinishError) {
                  console.error("[agent-long] onFinish threw", {
                    chatId,
                    error:
                      onFinishError instanceof Error
                        ? {
                            message: onFinishError.message,
                            stack: onFinishError.stack,
                          }
                        : String(onFinishError),
                  });
                  throw onFinishError;
                }
              },
            }),
          );
        },
      });

      const { waitUntilComplete } = streams.pipe("ui", uiStream);
      await waitUntilComplete();

      await phLogger.flush().catch(() => {});
    } catch (error) {
      await usageRefundTracker.refund().catch(() => {});
      chatLogger?.emitUnexpectedError(error);
      await ptySessionManager
        .closeAll(chatId)
        .catch((err) =>
          console.error("[agent-long] PTY closeAll (outer catch) failed:", err),
        );
      await phLogger.flush().catch(() => {});
      throw error;
    } finally {
      runCleanupMap.delete(ctx.run.id);
      // Clear the stored runId now that the stream is fully delivered.
      if (!payload.temporary) {
        try {
          await setActiveTriggerRun({ chatId, triggerRunId: null });
        } catch (error) {
          console.error(
            "[agent-long] failed to clear active_trigger_run_id:",
            error,
          );
        }
      }
    }

    return { chatId, assistantMessageId };
  },
});
