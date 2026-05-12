import { task, tags, metadata } from "@trigger.dev/sdk";
import { agentUiStream } from "./streams";
import { createUIMessageStream, generateId, UIMessage } from "ai";
import type { Geo } from "@vercel/functions";
import { countTokens } from "gpt-tokenizer";
import PostHogClient from "@/app/posthog";

import { systemPrompt } from "@/lib/system-prompt";
import { getResumeSection } from "@/lib/system-prompt/resume";
import { createTools } from "@/lib/ai/tools";
import { ptySessionManager } from "@/lib/ai/tools/utils/pty-session-manager";
import { generateTitleFromUserMessageWithWriter } from "@/lib/actions";
import { createTrackedProvider } from "@/lib/ai/providers";
import { processChatMessages } from "@/lib/chat/chat-processor";
import {
  sendRateLimitWarnings,
  SummarizationTracker,
  appendSystemReminderToLastUserMessage,
  estimatePreflightInputTokens,
  buildExtraUsageConfig,
  computeContextUsage,
  writeContextUsage,
  isContextUsageEnabled,
  isProviderApiError,
  injectNotesIntoMessages,
} from "@/lib/api/chat-stream-helpers";
import { PREEMPTIVE_TIMEOUT_FINISH_REASON } from "@/lib/chat/stop-conditions";
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
  setConvexUrl,
} from "@/lib/db/actions";
import { getMaxTokensForSubscription } from "@/lib/token-utils";
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
import {
  createAgentStream,
  initAgentStreamState,
  type AgentStreamContext,
} from "@/lib/api/agent-stream-runner";

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
  convexUrl?: string;
};

export const agentLongTask = task({
  id: "agent-long",
  maxDuration: 60 * 60,
  // Streaming tasks must not retry: a retry emits new chunks into the same
  // "ui" stream the client already subscribed to, producing duplicate output.
  // Provider errors are handled internally via the fallback-model path.
  retry: { maxAttempts: 1 },
  // Explicit preset for a 60-min run managing PTY sessions + sandbox.
  machine: { preset: "medium-1x" },

  onCancel: async ({
    ctx,
    runPromise,
  }: {
    ctx: { run: { id: string } };
    runPromise: Promise<unknown>;
  }) => {
    const cleanup = runCleanupMap.get(ctx.run.id);
    if (!cleanup) return;
    await Promise.race([
      runPromise.catch(() => undefined),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    await cleanup.usageRefundTracker.refund().catch(() => {});
    await ptySessionManager.closeAll(cleanup.chatId).catch(() => {});
    await phLogger.flush().catch(() => {});
    runCleanupMap.delete(ctx.run.id);
  },

  run: async (payload: AgentLongPayload, { ctx, signal: triggerSignal }) => {
    // Point the Convex client at the correct per-branch preview deployment.
    // NEXT_PUBLIC_CONVEX_URL in Trigger.dev's env vars only reflects the
    // main deployment; preview branches each have their own Convex URL.
    if (payload.convexUrl) {
      setConvexUrl(payload.convexUrl);
    }

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
    const mode = "agent" as const;

    // Capture task start time here, before any async setup, so the
    // elapsedTimeExceeds stop condition counts from task launch rather
    // than stream launch. Without this, slow setup (>2 min) would cause
    // the 58-min stop to fire after trigger.dev's 60-min hard SIGKILL.
    const taskStartTime = Date.now();

    // Tag for dashboard filtering; add subscription tier for paid-only queries.
    await tags.add([`user_${userId}`, `chat_${chatId}`]);
    if (subscription !== "free") await tags.add(`sub_${subscription}`);

    // Lifecycle metadata so the dashboard shows progress for long runs.
    metadata.set("status", "setup").set("chatId", chatId);

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

    runCleanupMap.set(ctx.run.id, { usageRefundTracker, chatLogger, chatId });

    try {
      const userCustomization = await getUserCustomization({ userId });

      // Re-fetch from DB so we have fileTokens for summarization.
      // The route already saved the user message; newMessages:[] avoids duplicates.
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
          const initialCtxUsage = contextUsageOn
            ? computeContextUsage(
                truncatedMessages,
                fileTokens,
                ctxSystemTokens,
                ctxMaxTokens,
              )
            : { usedTokens: 0, maxTokens: 0 };

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
            isTemporary: !!temporary as boolean | undefined,
          };
          finalMessages = await injectNotesIntoMessages(
            finalMessages,
            noteInjectionOpts,
          );

          // Mutable stream state — updated in-place by the shared runner and
          // read back here in toUIMessageStream.onFinish.
          const state = initAgentStreamState(finalMessages, initialCtxUsage);

          const budgetSnapshot = captureBudgetSnapshot({
            rateLimitInfo,
            extraUsageConfig,
            subscription,
          });
          const budgetMonitor = budgetSnapshot
            ? new BudgetMonitor(budgetSnapshot, writer, subscription)
            : null;

          // Use task start time (not stream start time) so the 58-min stop
          // condition always fires 2 min before the 60-min hard SIGKILL.
          const streamStartTime = taskStartTime;
          const configuredModelId =
            trackedProvider.languageModel(selectedModel).modelId;

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
              responseModel: state.responseModel,
              configuredModelId,
              rateLimitInfo,
            });
          };

          // Shared runner context — immutable deps + platform hook.
          const streamCtx: AgentStreamContext = {
            trackedProvider,
            currentSystemPrompt,
            tools,
            mode,
            userId,
            subscription,
            chatId,
            temporary,
            fileTokens,
            noteInjectionOpts,
            systemPromptTokens,
            ctxSystemTokens,
            ctxMaxTokens,
            streamStartTime,
            contextUsageOn,
            isReasoningModel: true, // long mode is always agent mode
            maxDurationMs: AGENT_LONG_MAX_DURATION_MS,
            writer,
            abortController: userStopSignal,
            summarizationTracker,
            usageTracker,
            budgetMonitor,
            sandboxManager,
            getTodoManager,
            ensureSandbox,
            chatLogger,
            usageRefundTracker,
            // trigger.dev has no Vercel-style hard preemptive timeout
            getHardTimeoutReason: () => null,
          };

          const createStream = (modelName: string) =>
            createAgentStream(modelName, streamCtx, state);

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
              state.lastStepInputTokens = 0;
              state.stoppedDueToTokenExhaustion = false;
              state.stoppedDueToElapsedTimeout = false;
              state.stoppedDueToDoomLoop = false;
              state.stoppedDueToBudgetExhaustion = false;
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
                  state.lastStepInputTokens = 0;
                  state.stoppedDueToTokenExhaustion = false;
                  state.stoppedDueToElapsedTimeout = false;
                  state.stoppedDueToDoomLoop = false;
                  state.stoppedDueToBudgetExhaustion = false;
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
                          usageTracker.cacheWriteTokens - preFallbackCacheWrite;
                        const fallbackCacheTotal =
                          fallbackCacheRead + fallbackCacheWrite;
                        chatLogger?.setSandbox(sandboxManager.getSandboxInfo());
                        chatLogger?.setCacheMetrics({
                          cacheHitRate:
                            fallbackCacheTotal > 0
                              ? fallbackCacheRead / fallbackCacheTotal
                              : null,
                          cacheReadTokens: fallbackCacheRead,
                          cacheWriteTokens: fallbackCacheWrite,
                        });
                        captureToolCalls({ posthog, chatLogger, userId, mode });
                        posthog?.shutdown();
                        chatLogger?.emitSuccess({
                          finishReason: state.streamFinishReason,
                          wasAborted: retryAborted,
                          wasPreemptiveTimeout: false,
                          hadSummarization: summarizationTracker.hasSummarized,
                        });

                        const generatedTitle = await titlePromise;
                        if (!temporary) {
                          const mergedTodos = getTodoManager().mergeWith(
                            baseTodos,
                            retryMessageId,
                          );
                          if (
                            generatedTitle ||
                            state.streamFinishReason ||
                            mergedTodos.length > 0
                          ) {
                            await updateChat({
                              chatId,
                              title: generatedTitle,
                              finishReason: state.streamFinishReason,
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
                              usage: state.streamUsage,
                              model: state.responseModel,
                              generationTimeMs: Date.now() - fallbackStartTime,
                              finishReason: state.streamFinishReason,
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

                // User-initiated cancel via trigger.dev: clear finish reason
                // so the client doesn't show spurious "going off course" messages.
                if (
                  isAborted &&
                  triggerSignal.aborted &&
                  !state.stoppedDueToBudgetExhaustion &&
                  !state.stoppedDueToElapsedTimeout
                ) {
                  state.streamFinishReason = undefined;
                }

                chatLogger?.setSandbox(sandboxManager.getSandboxInfo());
                chatLogger?.setCacheMetrics({
                  cacheHitRate: usageTracker.cacheHitRate,
                  cacheReadTokens: usageTracker.cacheReadTokens,
                  cacheWriteTokens: usageTracker.cacheWriteTokens,
                });
                captureToolCalls({ posthog, chatLogger, userId, mode });
                posthog?.shutdown();
                chatLogger?.emitSuccess({
                  finishReason: state.streamFinishReason,
                  wasAborted: isAborted,
                  wasPreemptiveTimeout: state.stoppedDueToElapsedTimeout,
                  hadSummarization: summarizationTracker.hasSummarized,
                });

                const generatedTitle = await titlePromise;

                if (!temporary) {
                  const mergedTodos = getTodoManager().mergeWith(
                    baseTodos,
                    assistantMessageId,
                  );
                  const shouldPersist = regenerate
                    ? true
                    : Boolean(
                        generatedTitle ||
                        state.streamFinishReason ||
                        mergedTodos.length > 0,
                      );

                  if (shouldPersist) {
                    await updateChat({
                      chatId,
                      title: generatedTitle,
                      finishReason: state.streamFinishReason,
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
                    state.streamUsage;
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
                    !triggerSignal.aborted &&
                    newFileIds.length === 0 &&
                    !hasIncompleteToolCalls &&
                    !resolvedUsage
                  ) {
                    await deductAccumulatedUsage();
                    return;
                  }

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
                      model: state.responseModel || configuredModelId,
                      generationTimeMs: Date.now() - streamStartTime,
                      finishReason: state.streamFinishReason,
                      usage: resolvedUsage ?? state.streamUsage,
                      updateOnly:
                        isAborted && !state.stoppedDueToElapsedTimeout
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
                      state.ctxUsage.usedTokens +
                      usageTracker.streamOutputTokens,
                    maxTokens: state.ctxUsage.maxTokens,
                  });
                }

                // Don't auto-continue on elapsed timeout — a 58-min run is large enough
                // that the user should explicitly decide whether to continue rather than
                // silently chaining up to 5 more hour-long runs.
                if (
                  (state.stoppedDueToTokenExhaustion ||
                    state.streamFinishReason === "tool-calls") &&
                  !temporary
                ) {
                  writeAutoContinue(writer);
                }

                await deductAccumulatedUsage();
              },
            }),
          );
        },
      });

      metadata.set("status", "streaming").set("model", selectedModel);
      const { waitUntilComplete } = agentUiStream.pipe(uiStream);
      await waitUntilComplete();

      metadata.set("status", "done");
      await phLogger.flush().catch(() => {});
    } catch (error) {
      metadata.set("status", "failed");
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
      if (!payload.temporary) {
        try {
          await setActiveTriggerRun({
            chatId,
            triggerRunId: null,
            expectedRunId: ctx.run.id,
          });
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
