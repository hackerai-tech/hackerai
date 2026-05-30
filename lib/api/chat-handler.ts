import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateId,
  UIMessage,
} from "ai";
import { systemPrompt } from "@/lib/system-prompt";
import { getResumeSection } from "@/lib/system-prompt/resume";
import { AGENT_MAX_STREAM_DURATION_MS } from "@/lib/chat/stop-conditions";
import { createTools } from "@/lib/ai/tools";
import { ptySessionManager } from "@/lib/ai/tools/utils/pty-session-manager";
import { generateTitleFromUserMessageWithWriter } from "@/lib/actions";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { assertUserCanMakeCostIncurringRequest } from "@/lib/suspensions";
import type {
  ChatMode,
  Todo,
  SandboxPreference,
  SelectedModel,
  RateLimitInfo,
} from "@/types";
import { coerceSelectedModel } from "@/types";
import { getBaseTodosForRequest } from "@/lib/utils/todo-utils";
import {
  acquireFreeRunConcurrencyLock,
  checkFreeMonthlyCostLimit,
  checkRateLimit,
  deductUsage,
  recordFreeMonthlyCost,
  UsageRefundTracker,
} from "@/lib/rate-limit";
import {
  BudgetMonitor,
  captureBudgetSnapshot,
} from "@/lib/chat/budget-monitor";
import { UsageTracker } from "@/lib/usage-tracker";
import { getMaxTokensForSubscription } from "@/lib/token-utils";
import { countTokens } from "gpt-tokenizer";
import { ChatSDKError } from "@/lib/errors";
import PostHogClient from "@/app/posthog";
import {
  captureAgentCompletionAnalytics,
  captureToolCalls,
  captureUsageCost,
  createChatLogger,
  shutdownPostHog,
  type ChatLogger,
} from "@/lib/api/chat-logger";
import {
  countFileAttachments,
  stripImageAttachments,
  sendRateLimitWarnings,
  isProviderApiError,
  computeContextUsage,
  writeContextUsage,
  isContextUsageEnabled,
  SummarizationTracker,
  appendSystemReminderToLastUserMessage,
  injectNotesIntoMessages,
  assertFreeAgentGates,
  buildExtraUsageConfig,
  estimatePreflightInputTokens,
  getRetryFallbackModel,
} from "@/lib/api/chat-stream-helpers";
import { geolocation } from "@vercel/functions";
import { NextRequest } from "next/server";
import {
  handleInitialChatAndUserMessage,
  saveMessage,
  updateChat,
  getMessagesByChatId,
  getUserCustomization,
  prepareForNewStream,
  startStream,
  startTempStream,
  deleteTempStreamForBackend,
} from "@/lib/db/actions";
import {
  createCancellationSubscriber,
  createPreemptiveTimeout,
} from "@/lib/utils/stream-cancellation";
import { v4 as uuidv4 } from "uuid";
import { processChatMessages, selectModel } from "@/lib/chat/chat-processor";
import { summarizeIncompleteToolParts } from "@/lib/chat/tool-abort-utils";
import { createTrackedProvider } from "@/lib/ai/providers";
import {
  uploadSandboxFiles,
  getUploadBasePath,
  rewriteSandboxFilePathsInMessages,
  stripLocalDesktopSourcePaths,
} from "@/lib/utils/sandbox-file-utils";
import { getEmptyProcessedMessagesCause } from "@/lib/utils/local-attachment-messages";
import { after } from "next/server";
import { createResumableStreamContext } from "resumable-stream";
import {
  writeUploadStartStatus,
  writeUploadCompleteStatus,
  writeAutoContinue,
} from "@/lib/utils/stream-writer-utils";
import { Id } from "@/convex/_generated/dataModel";
import { getMaxStepsForUser } from "@/lib/chat/chat-processor";
import { phLogger } from "@/lib/posthog/server";
import {
  extractErrorDetails,
  getUserFriendlyProviderError,
} from "@/lib/utils/error-utils";
import { isAgentMode } from "@/lib/utils/mode-helpers";
import {
  createAgentStream,
  initAgentStreamState,
  type AgentStreamContext,
} from "@/lib/api/agent-stream-runner";
import { FREE_RUN_LOCK_TTL_SECONDS } from "@/lib/rate-limit/free-config";

function getStreamContext() {
  try {
    return createResumableStreamContext({ waitUntil: after });
  } catch (_) {
    return null;
  }
}

export { getStreamContext };

export const createChatHandler = () => {
  return async (req: NextRequest) => {
    const endpoint = "/api/chat" as const;
    let preemptiveTimeout:
      | ReturnType<typeof createPreemptiveTimeout>
      | undefined;

    // Track usage deductions for refund on error
    const usageRefundTracker = new UsageRefundTracker();

    // Wide event logger for structured logging
    let chatLogger: ChatLogger | undefined;
    let outerChatId: string | undefined;
    let releaseFreeRunLock: (() => Promise<void>) | undefined;
    const releaseFreeRunLockOnce = async () => {
      const release = releaseFreeRunLock;
      if (!release) return;
      releaseFreeRunLock = undefined;
      await release();
    };

    try {
      const {
        messages,
        mode,
        todos,
        chatId,
        regenerate,
        temporary,
        sandboxPreference,
        selectedModel: rawSelectedModel,
        isAutoContinue,
        useClientMessagesForRegenerate,
      }: {
        messages: UIMessage[];
        mode: ChatMode;
        chatId: string;
        todos?: Todo[];
        regenerate?: boolean;
        temporary?: boolean;
        sandboxPreference?: SandboxPreference;
        selectedModel?: string;
        isAutoContinue?: boolean;
        useClientMessagesForRegenerate?: boolean;
      } = await req.json();
      outerChatId = chatId;

      const selectedModelOverride: SelectedModel | undefined =
        coerceSelectedModel(rawSelectedModel ?? null) ?? undefined;

      chatLogger = createChatLogger({ chatId, endpoint });
      chatLogger.setRequestDetails({
        mode,
        isTemporary: !!temporary,
        isRegenerate: !!regenerate,
      });

      const { userId, subscription, organizationId } =
        await getUserIDAndPro(req);
      await assertUserCanMakeCostIncurringRequest(userId);
      usageRefundTracker.setUser(userId, subscription, organizationId);
      if (subscription === "free") {
        const lock = await acquireFreeRunConcurrencyLock(
          userId,
          FREE_RUN_LOCK_TTL_SECONDS,
        );
        releaseFreeRunLock = lock.release;
      }
      const userLocation = geolocation(req);

      // Add user context to logger (only region, not full location for privacy)
      chatLogger.setUser({
        id: userId,
        subscription,
        region: userLocation?.region,
      });

      assertFreeAgentGates({
        mode,
        subscription,
        sandboxPreference,
        rawSelectedModel,
      });

      // Pre-emptive abort fires before Vercel's hard request timeout so we
      // can flush logs and refund usage; agent mode uses elapsedTimeExceeds.
      const userStopSignal = new AbortController();
      if (!isAgentMode(mode)) {
        preemptiveTimeout = createPreemptiveTimeout({
          chatId,
          endpoint,
          abortController: userStopSignal,
        });
      }

      const userCustomization = await getUserCustomization({ userId });

      const fetched = await getMessagesByChatId({
        chatId,
        userId,
        subscription,
        newMessages: messages,
        regenerate,
        isTemporary: temporary,
        mode,
        useClientMessagesForRegenerate,
      });
      const { chat, isNewChat, fileTokens } = fetched;
      const truncatedMessages =
        subscription === "free"
          ? stripImageAttachments(fetched.truncatedMessages)
          : fetched.truncatedMessages;

      const baseTodos: Todo[] = getBaseTodosForRequest(
        (chat?.todos as unknown as Todo[]) || [],
        Array.isArray(todos) ? todos : [],
        { isTemporary: !!temporary, regenerate },
      );

      if (!temporary) {
        await handleInitialChatAndUserMessage({
          chatId,
          userId,
          messages: stripLocalDesktopSourcePaths(truncatedMessages),
          regenerate,
          chat,
          isHidden: isAutoContinue ? true : undefined,
        });
      }

      // Free ask: pre-flight rate-limit before any token counting/model work.
      const freeAskRateLimitInfo =
        mode === "ask" && subscription === "free"
          ? await checkRateLimit(userId, mode, subscription)
          : null;

      const uploadBasePath = isAgentMode(mode)
        ? getUploadBasePath(sandboxPreference)
        : undefined;

      let { processedMessages, selectedModel, sandboxFiles } =
        await processChatMessages({
          messages: truncatedMessages,
          mode,
          userId,
          subscription,
          uploadBasePath,
          modelOverride: selectedModelOverride,
          allowLocalDesktopFiles:
            isAgentMode(mode) && sandboxPreference === "desktop",
        });

      // Empty after processing → Gemini rejects with "must include at least one parts field".
      if (!processedMessages || processedMessages.length === 0) {
        throw new ChatSDKError(
          "bad_request:api",
          getEmptyProcessedMessagesCause(truncatedMessages),
        );
      }

      const memoryEnabled =
        (subscription !== "free" || isAgentMode(mode)) &&
        (userCustomization?.include_memory_entries ?? true);

      const estimatedInputTokens = await estimatePreflightInputTokens({
        mode,
        subscription,
        userId,
        selectedModel,
        userCustomization,
        temporary,
        truncatedMessages,
      });

      const fileCounts = countFileAttachments(truncatedMessages);
      chatLogger.setChat(
        {
          messageCount: truncatedMessages.length,
          estimatedInputTokens,
          isNewChat,
          fileCount: fileCounts.totalFiles,
          imageCount: fileCounts.imageCount,
          memoryEnabled,
        },
        selectedModel,
      );

      const extraUsageConfig = await buildExtraUsageConfig({
        userId,
        subscription,
        userCustomization,
        organizationId,
      });

      const rateLimitInfo: RateLimitInfo =
        freeAskRateLimitInfo ??
        (await checkRateLimit(
          userId,
          mode,
          subscription,
          estimatedInputTokens,
          extraUsageConfig,
          selectedModel,
          organizationId,
        ));

      const freeMonthlyBudgetSnapshot =
        subscription === "free"
          ? await checkFreeMonthlyCostLimit(userId)
          : null;

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

      // PostHog client for analytics (initialized once, used at end of request)
      const posthog = PostHogClient();

      const assistantMessageId = uuidv4();
      chatLogger.getBuilder().setAssistantId(assistantMessageId);

      if (temporary) {
        try {
          await startTempStream({ chatId, userId });
        } catch {
          // Best-effort; temp coordination must not block the request.
        }
      }

      // Start cancellation subscriber (Redis pub/sub with fallback to polling)
      let subscriberStopped = false;
      const cancellationSubscriber = await createCancellationSubscriber({
        chatId,
        isTemporary: !!temporary,
        abortController: userStopSignal,
        onStop: () => {
          subscriberStopped = true;
        },
      });

      const summarizationTracker = new SummarizationTracker();

      chatLogger.startStream();

      const stream = createUIMessageStream({
        onError: (error) => {
          // Surface ChatSDKError causes (e.g., upload failures) to the client
          // so MessageErrorState renders the user-actionable message.
          if (error instanceof ChatSDKError) {
            return typeof error.cause === "string"
              ? error.cause
              : error.message;
          }
          return getUserFriendlyProviderError(error);
        },
        execute: async ({ writer }) => {
          try {
            sendRateLimitWarnings(writer, {
              subscription,
              mode,
              rateLimitInfo,
            });

            const {
              tools,
              getSandbox,
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
              temporary,
              assistantMessageId,
              sandboxPreference,
              process.env.CONVEX_SERVICE_ROLE_KEY,
              userCustomization?.guardrails_config,
              // Caido proxy temporarily disabled for all users.
              // Was: subscription !== "free" && (userCustomization?.caido_enabled ?? false)
              false,
              undefined, // caido_port (disabled)
              undefined, // appendMetadataStream
              (costDollars: number) => {
                usageTracker.providerCost += costDollars;
                usageTracker.nonModelCost += costDollars;
                chatLogger?.getBuilder().addToolCost(costDollars);
              },
              subscription,
              (info) => chatLogger?.setSandboxBoot(info),
              (info) => chatLogger?.setCaidoReady(info),
            );

            // Helper to send file metadata via stream for resumable stream clients
            // Uses accumulated metadata directly - no DB query needed!
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

            // Get sandbox context for system prompt (only for local sandboxes)
            let sandboxContext: string | null = null;
            if (
              isAgentMode(mode) &&
              "getSandboxContextForPrompt" in sandboxManager
            ) {
              try {
                sandboxContext = await (
                  sandboxManager as {
                    getSandboxContextForPrompt: () => Promise<string | null>;
                  }
                ).getSandboxContextForPrompt();
              } catch (error) {
                console.warn(
                  "Failed to get sandbox context for prompt:",
                  error,
                );
              }
            }

            if (isAgentMode(mode) && sandboxFiles && sandboxFiles.length > 0) {
              writeUploadStartStatus(
                writer,
                sandboxFiles.every((file) => file.kind === "localPath")
                  ? "Preparing local attachments on your computer"
                  : "Uploading attachments to the computer",
              );
              let uploadResult: Awaited<ReturnType<typeof uploadSandboxFiles>> =
                {
                  failedCount: 0,
                  pathRewrites: [],
                };
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
                // Errors thrown from execute are caught by createUIMessageStream's
                // onError and never reach the outer catch, so refund / timeout
                // clear / error logging must happen here. refund() is idempotent.
                preemptiveTimeout?.clear();
                await usageRefundTracker.refund();
                chatLogger?.emitChatError(uploadError);
                throw uploadError;
              }
              processedMessages = rewriteSandboxFilePathsInMessages(
                processedMessages,
                uploadResult.pathRewrites,
              );
            }

            // Generate title in parallel only for non-temporary new chats
            const titlePromise =
              isNewChat && !temporary
                ? generateTitleFromUserMessageWithWriter(
                    processedMessages,
                    writer,
                  )
                : Promise.resolve(undefined);

            const trackedProvider = createTrackedProvider();

            let currentSystemPrompt = await systemPrompt(
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
            // finalMessages will be set in prepareStep if summarization is needed
            let finalMessages = processedMessages;

            // Inject resume context into messages instead of system prompt
            // to keep the system prompt stable for caching
            const resumeContext = getResumeSection(chat?.finish_reason);
            if (resumeContext) {
              finalMessages = appendSystemReminderToLastUserMessage(
                finalMessages,
                resumeContext,
              );
            }

            // Inject notes into messages instead of system prompt
            // to keep the system prompt stable for prompt caching
            const shouldIncludeNotes =
              userCustomization?.include_memory_entries ?? true;
            const noteInjectionOpts = {
              userId,
              subscription,
              shouldIncludeNotes,
              isTemporary: temporary,
            };
            finalMessages = await injectNotesIntoMessages(
              finalMessages,
              noteInjectionOpts,
            );

            // Mutable stream state — updated in-place by the shared runner.
            const state = initAgentStreamState(
              finalMessages,
              contextUsageOn
                ? computeContextUsage(
                    truncatedMessages,
                    fileTokens,
                    ctxSystemTokens,
                    ctxMaxTokens,
                  )
                : { usedTokens: 0, maxTokens: 0 },
            );

            // Mid-stream budget enforcement. Paid users use their subscription
            // bucket; free users use an internal monthly cost cap.
            const budgetSnapshot = captureBudgetSnapshot({
              rateLimitInfo,
              extraUsageConfig,
              subscription,
            });
            const effectiveBudgetSnapshot =
              budgetSnapshot ??
              (freeMonthlyBudgetSnapshot?.rateLimitSkipped
                ? null
                : freeMonthlyBudgetSnapshot);
            const budgetMonitor = effectiveBudgetSnapshot
              ? new BudgetMonitor(effectiveBudgetSnapshot, writer, subscription)
              : null;
            const isReasoningModel = isAgentMode(mode);

            const streamStartTime = Date.now();
            const configuredModelId =
              trackedProvider.languageModel(selectedModel).modelId;

            let isRetryWithFallback = false;
            const isAutoModel = [
              "ask-model",
              "ask-model-free",
              "agent-model",
              "agent-model-free",
            ].includes(selectedModel);
            const fallbackModel = getRetryFallbackModel(selectedModel, mode);
            const fallbackModelId =
              trackedProvider.languageModel(fallbackModel).modelId;

            const usageTracker = new UsageTracker();
            let hasRecordedUsage = false;
            // Snapshot cache tokens before fallback retry so we can isolate fallback-only metrics
            let preFallbackCacheRead = 0;
            let preFallbackCacheWrite = 0;

            const deductAccumulatedUsage = async () => {
              try {
                if (hasRecordedUsage) return;
                // Add E2B sandbox session cost (duration-based)
                const sandboxCost = getSandboxSessionCost();
                if (sandboxCost > 0) {
                  usageTracker.providerCost += sandboxCost;
                  usageTracker.nonModelCost += sandboxCost;
                  chatLogger?.getBuilder().addToolCost(sandboxCost);
                }

                if (!usageTracker.hasUsage) {
                  // No usage data reported — skip deduction
                  return;
                }
                hasRecordedUsage = true;
                const usageCostRecord = usageTracker.createUsageCostRecord({
                  selectedModel,
                  selectedModelOverride,
                  responseModel: state.responseModel,
                  configuredModelId,
                  rateLimitInfo,
                });

                // Trust accumulated provider cost (sum of per-step usage.raw.cost) even on
                // non-clean streams. Each completed step reports authoritative cost with
                // cache discounts baked in, so summing them is more accurate than the
                // token-based fallback (which ignores cache reads and overcharges).
                // Gate on modelProviderCost (not providerCost) because providerCost also
                // includes tool/sandbox spend — if the model never reported raw.cost,
                // tool/sandbox cost alone would incorrectly suppress the token fallback
                // and drop the model portion entirely.
                const providerCost =
                  usageTracker.modelProviderCost > 0
                    ? usageTracker.providerCost
                    : undefined;

                if (subscription === "free") {
                  await recordFreeMonthlyCost(
                    userId,
                    usageCostRecord.costDollars,
                  );
                } else {
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
                    organizationId,
                  );
                  usageTracker.log({
                    userId,
                    organizationId,
                    chatId,
                    endpoint,
                    mode,
                    subscription,
                    selectedModel,
                    selectedModelOverride,
                    responseModel: state.responseModel,
                    configuredModelId,
                    rateLimitInfo,
                  });
                }
                captureUsageCost({
                  posthog,
                  userId,
                  subscription,
                  organizationId,
                  chatId,
                  endpoint,
                  mode,
                  usage: usageCostRecord,
                });
              } finally {
                await releaseFreeRunLockOnce();
              }
            };

            // Shared runner context.
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
              isReasoningModel,
              maxDurationMs: AGENT_MAX_STREAM_DURATION_MS,
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
              getHardTimeoutReason: () =>
                preemptiveTimeout?.isPreemptive() ? "timeout" : null,
            };

            const createStream = (modelName: string) =>
              createAgentStream(modelName, streamCtx, state);

            let result;
            try {
              result = await createStream(selectedModel);
            } catch (error) {
              // If provider returns error (e.g., INVALID_ARGUMENT from Gemini), retry with fallback.
              if (
                isProviderApiError(error) &&
                !isRetryWithFallback &&
                isAutoModel
              ) {
                phLogger.error("Provider API error, retrying with fallback", {
                  error,
                  chatId,
                  endpoint,
                  mode,
                  providerGateway: "openrouter",
                  originalModel: selectedModel,
                  requestedModelSlug: configuredModelId,
                  fallbackModel,
                  fallbackModelSlug: fallbackModelId,
                  userId,
                  subscription,
                  isTemporary: temporary,
                  preFallbackCacheReadTokens: usageTracker.cacheReadTokens,
                  preFallbackCacheWriteTokens: usageTracker.cacheWriteTokens,
                  ...extractErrorDetails(error),
                });

                isRetryWithFallback = true;
                state.lastStepInputTokens = 0;
                state.stoppedDueToTokenExhaustion = false;
                state.stoppedDueToElapsedTimeout = false;
                state.stoppedDueToDoomLoop = false;
                state.stoppedDueToBudgetExhaustion = false;
                preFallbackCacheRead = usageTracker.cacheReadTokens;
                preFallbackCacheWrite = usageTracker.cacheWriteTokens;
                // Discard the failed primary leg's model usage so the user is
                // only billed for the fallback. Non-model spend (sandbox/tools)
                // is preserved.
                usageTracker.resetModelLeg();
                result = await createStream(fallbackModel);
              } else {
                throw error;
              }
            }

            writer.merge(
              result.toUIMessageStream({
                generateMessageId: () => assistantMessageId,
                messageMetadata: ({ part }) => {
                  if (part.type === "start") {
                    return { mode, generationStartedAt: streamStartTime };
                  }

                  if (part.type === "finish") {
                    return {
                      mode,
                      generationStartedAt: streamStartTime,
                      generationTimeMs: Date.now() - streamStartTime,
                    };
                  }
                },
                onFinish: async ({ messages, isAborted }) => {
                  let retryScheduled = false;
                  try {
                    // Check if stream finished with only step-start (indicates incomplete response)
                    const lastAssistantMessage = messages
                      .slice()
                      .reverse()
                      .find((m) => m.role === "assistant");
                    const hasOnlyStepStart =
                      lastAssistantMessage?.parts?.length === 1 &&
                      lastAssistantMessage.parts[0]?.type === "step-start";

                    if (hasOnlyStepStart) {
                      phLogger.warn(
                        "Stream finished incomplete - triggering fallback",
                        {
                          chatId,
                          endpoint,
                          mode,
                          model: selectedModel,
                          userId,
                          subscription,
                          isTemporary: temporary,
                          messageCount: messages.length,
                          parts: lastAssistantMessage?.parts,
                          isRetryWithFallback,
                          assistantMessageId,
                        },
                      );

                      // Retry with fallback model if not already retrying (only for auto models)
                      if (!isRetryWithFallback && !isAborted && isAutoModel) {
                        isRetryWithFallback = true;
                        state.lastStepInputTokens = 0;
                        state.stoppedDueToTokenExhaustion = false;
                        state.stoppedDueToElapsedTimeout = false;
                        state.stoppedDueToDoomLoop = false;
                        state.stoppedDueToBudgetExhaustion = false;
                        const fallbackStartTime = Date.now();
                        preFallbackCacheRead = usageTracker.cacheReadTokens;
                        preFallbackCacheWrite = usageTracker.cacheWriteTokens;

                        // Discard the failed primary leg's model usage so the
                        // user is only billed for the fallback. Non-model spend
                        // (sandbox/tools) is preserved.
                        usageTracker.resetModelLeg();

                        const retryResult = await createStream(fallbackModel);
                        const retryMessageId = generateId();

                        writer.merge(
                          retryResult.toUIMessageStream({
                            generateMessageId: () => retryMessageId,
                            messageMetadata: ({ part }) => {
                              if (part.type === "start") {
                                return {
                                  mode,
                                  generationStartedAt: fallbackStartTime,
                                };
                              }

                              if (part.type === "finish") {
                                return {
                                  mode,
                                  generationStartedAt: fallbackStartTime,
                                  generationTimeMs:
                                    Date.now() - fallbackStartTime,
                                };
                              }
                            },
                            onFinish: async ({
                              messages: retryMessages,
                              isAborted: retryAborted,
                            }) => {
                              try {
                                // Cleanup for retry
                                preemptiveTimeout?.clear();
                                if (!subscriberStopped) {
                                  await cancellationSubscriber.stop();
                                  subscriberStopped = true;
                                }

                                const sandboxInfo =
                                  sandboxManager.getSandboxInfo();
                                chatLogger!.setSandbox(sandboxInfo);
                                // Use fallback-only cache tokens (subtract pre-fallback snapshot)
                                // so the wide event isn't mixing cumulative cache with retry-only usage
                                const fallbackCacheRead =
                                  usageTracker.cacheReadTokens -
                                  preFallbackCacheRead;
                                const fallbackCacheWrite =
                                  usageTracker.cacheWriteTokens -
                                  preFallbackCacheWrite;
                                const fallbackCacheTotal =
                                  fallbackCacheRead + fallbackCacheWrite;
                                chatLogger!.setCacheMetrics({
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
                                const outcome = retryAborted
                                  ? "aborted"
                                  : "success";
                                captureAgentCompletionAnalytics({
                                  posthog,
                                  userId,
                                  chatId,
                                  endpoint,
                                  mode,
                                  subscription,
                                  sandboxInfo,
                                  outcome,
                                  chatLogger,
                                });
                                shutdownPostHog(posthog);
                                chatLogger!.emitSuccess({
                                  finishReason: state.streamFinishReason,
                                  wasAborted: retryAborted,
                                  wasPreemptiveTimeout: false,
                                  hadSummarization:
                                    summarizationTracker.hasSummarized,
                                });

                                const generatedTitle = await titlePromise;

                                if (!temporary) {
                                  const mergedTodos =
                                    getTodoManager().mergeWith(
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
                                      defaultModelSlug: mode,
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

                                  // Only save NEW assistant messages from retry (skip already-saved user messages)
                                  for (const msg of retryMessages) {
                                    if (msg.role !== "assistant") continue;

                                    const processed =
                                      summarizationTracker.processMessageForSave(
                                        msg,
                                      );

                                    await saveMessage({
                                      chatId,
                                      userId,
                                      message: processed,
                                      extraFileIds: newFileIds,
                                      usage: state.streamUsage,
                                      model: state.responseModel,
                                      mode,
                                      generationStartedAt: fallbackStartTime,
                                      generationTimeMs:
                                        Date.now() - fallbackStartTime,
                                      finishReason: state.streamFinishReason,
                                    });
                                  }

                                  // Send file metadata via stream for resumable stream clients
                                  sendFileMetadataToStream(accumulatedFiles);
                                } else {
                                  // For temporary chats, send file metadata via stream before cleanup
                                  const tempFiles =
                                    getFileAccumulator().getAll();
                                  sendFileMetadataToStream(tempFiles);

                                  // Ensure temp stream row is removed backend-side
                                  await deleteTempStreamForBackend({ chatId });
                                }

                                // Verify fallback produced valid content
                                const fallbackAssistantMessage = retryMessages
                                  .slice()
                                  .reverse()
                                  .find((m) => m.role === "assistant");
                                const fallbackHasContent =
                                  fallbackAssistantMessage?.parts?.some(
                                    (p) =>
                                      p.type === "text" ||
                                      p.type?.startsWith("tool-") ||
                                      p.type === "reasoning",
                                  ) ?? false;
                                const fallbackPartTypes =
                                  fallbackAssistantMessage?.parts?.map(
                                    (p) => p.type,
                                  ) ?? [];

                                phLogger.info("Fallback completed", {
                                  chatId,
                                  endpoint,
                                  mode,
                                  originalModel: selectedModel,
                                  originalAssistantMessageId:
                                    assistantMessageId,
                                  fallbackModel,
                                  fallbackAssistantMessageId: retryMessageId,
                                  fallbackDurationMs:
                                    Date.now() - fallbackStartTime,
                                  fallbackSuccess: fallbackHasContent,
                                  fallbackWasAborted: retryAborted,
                                  fallbackMessageCount: retryMessages.length,
                                  fallbackPartTypes,
                                  preFallbackCacheReadTokens:
                                    preFallbackCacheRead,
                                  preFallbackCacheWriteTokens:
                                    preFallbackCacheWrite,
                                  fallbackCacheReadTokens: fallbackCacheRead,
                                  fallbackCacheWriteTokens: fallbackCacheWrite,
                                  fallbackCacheHitRate:
                                    fallbackCacheTotal > 0
                                      ? fallbackCacheRead / fallbackCacheTotal
                                      : null,
                                  userId,
                                  subscription,
                                  isTemporary: temporary,
                                  paidAskMode:
                                    mode === "ask" && subscription !== "free",
                                });

                                // Deduct accumulated usage (includes both original + retry streams)
                                await deductAccumulatedUsage();
                              } finally {
                                await releaseFreeRunLockOnce();
                              }
                            },
                            sendReasoning: true,
                          }),
                        );

                        retryScheduled = true;
                        return; // Skip normal cleanup - retry handles it
                      }
                    }

                    const isPreemptiveAbort =
                      preemptiveTimeout?.isPreemptive() ?? false;
                    const onFinishStartTime = Date.now();
                    const triggerTime = preemptiveTimeout?.getTriggerTime();

                    // Helper to log step timing during preemptive timeout
                    const logStep = (step: string, stepStartTime: number) => {
                      if (isPreemptiveAbort) {
                        const stepDuration = Date.now() - stepStartTime;
                        const totalElapsed =
                          Date.now() - (triggerTime || onFinishStartTime);
                        phLogger.info("Preemptive timeout cleanup step", {
                          chatId,
                          step,
                          stepDurationMs: stepDuration,
                          totalElapsedSinceTriggerMs: totalElapsed,
                          endpoint,
                        });
                      }
                    };

                    if (isPreemptiveAbort) {
                      phLogger.info("Preemptive timeout onFinish started", {
                        chatId,
                        endpoint,
                        timeSinceTriggerMs: triggerTime
                          ? onFinishStartTime - triggerTime
                          : null,
                        messageCount: messages.length,
                        isTemporary: temporary,
                      });
                    }

                    // Clear pre-emptive timeout
                    let stepStart = Date.now();
                    preemptiveTimeout?.clear();
                    logStep("clear_timeout", stepStart);

                    // Stop cancellation subscriber
                    stepStart = Date.now();
                    await cancellationSubscriber.stop();
                    subscriberStopped = true;
                    logStep("stop_cancellation_subscriber", stepStart);

                    // Clear finish reason for user-initiated aborts (not pre-emptive timeouts)
                    // This prevents showing "going off course" message when user clicks stop
                    if (isAborted && !isPreemptiveAbort) {
                      state.streamFinishReason = undefined;
                    }

                    // Emit wide event
                    stepStart = Date.now();
                    const sandboxInfo = sandboxManager.getSandboxInfo();
                    chatLogger!.setSandbox(sandboxInfo);
                    chatLogger!.setCacheMetrics({
                      cacheHitRate: usageTracker.cacheHitRate,
                      cacheReadTokens: usageTracker.cacheReadTokens,
                      cacheWriteTokens: usageTracker.cacheWriteTokens,
                    });
                    captureToolCalls({ posthog, chatLogger, userId, mode });
                    const outcome = isAborted ? "aborted" : "success";
                    captureAgentCompletionAnalytics({
                      posthog,
                      userId,
                      chatId,
                      endpoint,
                      mode,
                      subscription,
                      sandboxInfo,
                      outcome,
                      chatLogger,
                    });
                    shutdownPostHog(posthog);
                    chatLogger!.emitSuccess({
                      finishReason: state.streamFinishReason,
                      wasAborted: isAborted,
                      wasPreemptiveTimeout: isPreemptiveAbort,
                      hadSummarization: summarizationTracker.hasSummarized,
                    });
                    logStep("emit_success_event", stepStart);

                    // Sandbox cleanup is automatic with auto-pause
                    // The sandbox will auto-pause after inactivity timeout (7 minutes)
                    // No manual pause needed

                    // Always wait for title generation to complete
                    stepStart = Date.now();
                    const generatedTitle = await titlePromise;
                    logStep("wait_title_generation", stepStart);

                    if (!temporary) {
                      stepStart = Date.now();
                      const mergedTodos = getTodoManager().mergeWith(
                        baseTodos,
                        assistantMessageId,
                      );
                      logStep("merge_todos", stepStart);

                      const shouldPersist = regenerate
                        ? true
                        : Boolean(
                            generatedTitle ||
                            state.streamFinishReason ||
                            mergedTodos.length > 0,
                          );

                      if (shouldPersist) {
                        // updateChat automatically clears stream state (active_stream_id and canceled_at)
                        stepStart = Date.now();
                        await updateChat({
                          chatId,
                          title: generatedTitle,
                          finishReason: state.streamFinishReason,
                          todos: mergedTodos,
                          defaultModelSlug: mode,
                          sandboxType: sandboxManager.getEffectivePreference(),
                          selectedModel: selectedModelOverride,
                        });
                        logStep("update_chat", stepStart);
                      } else {
                        // If not persisting, still need to clear stream state
                        stepStart = Date.now();
                        await prepareForNewStream({ chatId });
                        logStep("prepare_for_new_stream", stepStart);
                      }

                      stepStart = Date.now();
                      const accumulatedFiles = getFileAccumulator().getAll();
                      const newFileIds = accumulatedFiles.map((f) => f.fileId);
                      logStep("get_accumulated_files", stepStart);

                      // Check if any messages have incomplete tool calls that need completion
                      const hasIncompleteToolCalls = messages.some(
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
                      const incompleteToolSummaries = isAborted
                        ? summarizeIncompleteToolParts(messages)
                        : [];
                      if (incompleteToolSummaries.length > 0) {
                        console.info(
                          JSON.stringify({
                            level: "info",
                            event: "abort_incomplete_tool_calls_detected",
                            service: "chat-handler",
                            timestamp: new Date().toISOString(),
                            chat_id: chatId,
                            user_id: userId,
                            mode,
                            finish_reason: state.streamFinishReason,
                            is_preemptive_abort: isPreemptiveAbort,
                            incomplete_tool_count:
                              incompleteToolSummaries.length,
                            incomplete_tools: incompleteToolSummaries,
                          }),
                        );
                      }

                      // On abort, streamText.onFinish may not have fired yet, so state.streamUsage
                      // could be undefined. Await usage from result to ensure we capture it.
                      // This must happen BEFORE we decide whether to skip saving.
                      let resolvedUsage: Record<string, unknown> | undefined =
                        state.streamUsage;
                      if (!resolvedUsage && isAborted) {
                        try {
                          resolvedUsage = (await result.usage) as Record<
                            string,
                            unknown
                          >;
                        } catch {
                          // Usage unavailable on abort - continue without it
                        }
                      }

                      const hasUsageToRecord = Boolean(resolvedUsage);
                      const shouldSkipSaveSignal =
                        cancellationSubscriber.shouldSkipSave();

                      // If user aborted (not pre-emptive), skip message save when:
                      // 1. skipSave signal received via Redis (edit/regenerate/retry — message will be discarded)
                      // 2. No files, tools, or usage to record (frontend already saved the message)
                      if (
                        isAborted &&
                        !isPreemptiveAbort &&
                        (shouldSkipSaveSignal ||
                          (newFileIds.length === 0 &&
                            !hasIncompleteToolCalls &&
                            !hasUsageToRecord))
                      ) {
                        console.info(
                          JSON.stringify({
                            level: "info",
                            event: "abort_message_save_skipped",
                            service: "chat-handler",
                            timestamp: new Date().toISOString(),
                            chat_id: chatId,
                            user_id: userId,
                            mode,
                            finish_reason: state.streamFinishReason,
                            skip_save_signal: shouldSkipSaveSignal,
                            new_file_count: newFileIds.length,
                            has_incomplete_tool_calls: hasIncompleteToolCalls,
                            has_usage_to_record: hasUsageToRecord,
                          }),
                        );
                        await deductAccumulatedUsage();
                        return;
                      }

                      // Save messages (either full save or just append extraFileIds)
                      stepStart = Date.now();
                      for (const message of messages) {
                        let processedMessage =
                          summarizationTracker.processMessageForSave(message);

                        // Skip saving messages with no parts or files
                        // This prevents saving empty messages on error that would accumulate on retry
                        if (
                          (!processedMessage.parts ||
                            processedMessage.parts.length === 0) &&
                          newFileIds.length === 0
                        ) {
                          continue;
                        }

                        // Use resolvedUsage which was already awaited above on abort
                        // Falls back to state.streamUsage for non-abort cases
                        // On user-initiated abort, use updateOnly as safety net:
                        // only patch existing messages (add files/usage), don't create new ones.
                        // This prevents orphan messages when Redis skipSave signal was missed.
                        try {
                          await saveMessage({
                            chatId,
                            userId,
                            message: processedMessage,
                            extraFileIds: newFileIds,
                            model: state.responseModel || configuredModelId,
                            mode,
                            generationStartedAt:
                              processedMessage.role === "assistant"
                                ? streamStartTime
                                : undefined,
                            generationTimeMs: Date.now() - streamStartTime,
                            finishReason: state.streamFinishReason,
                            usage: resolvedUsage ?? state.streamUsage,
                            updateOnly:
                              isAborted && !isPreemptiveAbort
                                ? true
                                : undefined,
                            isHidden:
                              isAutoContinue && processedMessage.role === "user"
                                ? true
                                : undefined,
                            wasAborted: isAborted,
                            wasPreemptiveTimeout: isPreemptiveAbort,
                          });
                        } catch (error) {
                          if (isPreemptiveAbort) {
                            console.error(
                              JSON.stringify({
                                level: "error",
                                event: "preemptive_timeout_message_save_failed",
                                service: "chat-handler",
                                timestamp: new Date().toISOString(),
                                chat_id: chatId,
                                user_id: userId,
                                message_id: processedMessage.id,
                                message_role: processedMessage.role,
                                mode,
                                model: state.responseModel || configuredModelId,
                                finish_reason: state.streamFinishReason,
                                time_since_timeout_trigger_ms: triggerTime
                                  ? Date.now() - triggerTime
                                  : null,
                                stream_duration_ms:
                                  Date.now() - streamStartTime,
                                error_name:
                                  error instanceof Error
                                    ? error.name
                                    : typeof error,
                                error_message:
                                  error instanceof Error
                                    ? error.message
                                    : String(error),
                                error_metadata:
                                  error &&
                                  typeof error === "object" &&
                                  "metadata" in error
                                    ? (error as { metadata?: unknown }).metadata
                                    : undefined,
                              }),
                            );
                          }
                          throw error;
                        }
                      }
                      logStep("save_messages", stepStart);

                      // Send file metadata via stream for resumable stream clients
                      // Uses accumulated metadata directly - no DB query needed!
                      stepStart = Date.now();
                      sendFileMetadataToStream(accumulatedFiles);
                      logStep("send_file_metadata", stepStart);
                    } else {
                      // For temporary chats, send file metadata via stream before cleanup
                      stepStart = Date.now();
                      const tempFiles = getFileAccumulator().getAll();
                      sendFileMetadataToStream(tempFiles);
                      logStep("send_temp_file_metadata", stepStart);

                      // Ensure temp stream row is removed backend-side
                      stepStart = Date.now();
                      await deleteTempStreamForBackend({ chatId });
                      logStep("delete_temp_stream", stepStart);
                    }

                    if (isPreemptiveAbort) {
                      const totalDuration = Date.now() - onFinishStartTime;
                      phLogger.info("Preemptive timeout onFinish completed", {
                        chatId,
                        endpoint,
                        totalOnFinishDurationMs: totalDuration,
                        totalSinceTriggerMs: triggerTime
                          ? Date.now() - triggerTime
                          : null,
                      });
                      await phLogger.flush();
                    }

                    // Send updated context usage with output tokens included
                    if (contextUsageOn) {
                      writeContextUsage(writer, {
                        usedTokens:
                          state.ctxUsage.usedTokens +
                          usageTracker.streamOutputTokens,
                        maxTokens: state.ctxUsage.maxTokens,
                      });
                    }

                    if (
                      (state.stoppedDueToTokenExhaustion ||
                        state.stoppedDueToElapsedTimeout ||
                        state.streamFinishReason === "tool-calls") &&
                      isAgentMode(mode) &&
                      !temporary
                    ) {
                      writeAutoContinue(writer);
                    }

                    await deductAccumulatedUsage();
                  } finally {
                    if (!retryScheduled) {
                      await releaseFreeRunLockOnce();
                    }
                  }
                },
                sendReasoning: true,
              }),
            );
          } catch (error) {
            await releaseFreeRunLockOnce();
            throw error;
          }
        },
      });

      return createUIMessageStreamResponse({
        stream,
        headers: {
          "Transfer-Encoding": "chunked",
        },
        async consumeSseStream({ stream: sseStream }) {
          // Temporary chats do not support resumption
          if (temporary) {
            return;
          }

          try {
            const streamContext = getStreamContext();
            if (streamContext) {
              const streamId = generateId();
              await startStream({ chatId, streamId });
              await streamContext.createNewResumableStream(
                streamId,
                () => sseStream,
              );
            }
          } catch (error) {
            // Non-fatal: stream still works without resumability
            phLogger.warn("Stream resumption setup failed", {
              chatId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      });
    } catch (error) {
      // Clear timeout if error occurs before onFinish
      preemptiveTimeout?.clear();
      await releaseFreeRunLockOnce();

      // Best-effort PTY cleanup — the stream may never have reached onFinish.
      if (outerChatId) {
        await ptySessionManager
          .closeAll(outerChatId)
          .catch((err) =>
            console.error(
              "[chat-handler] PTY closeAll (outer catch) failed:",
              err,
            ),
          );
      }

      // Refund the upfront deduction when the request fails before any tokens
      // were consumed. refund() is idempotent and only fires if deductions were
      // recorded and nothing has been refunded yet.
      await usageRefundTracker.refund();

      // Handle ChatSDKErrors (including authentication errors)
      if (error instanceof ChatSDKError) {
        chatLogger?.emitChatError(error);
        return error.toResponse();
      }

      // Handle unexpected errors (provider failures, etc.)
      chatLogger?.emitUnexpectedError(error);

      const unexpectedError = new ChatSDKError(
        "bad_request:stream",
        getUserFriendlyProviderError(error),
      );
      return unexpectedError.toResponse();
    }
  };
};
