import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateId,
} from "ai";
import { systemPrompt } from "@/lib/system-prompt";
import { getResumeSection } from "@/lib/system-prompt/resume";
import {
  AGENT_MAX_STREAM_DURATION_MS,
  BUDGET_EXHAUSTION_FINISH_REASON,
  getAgentAutoContinueStopSource,
} from "@/lib/chat/stop-conditions";
import { createTools } from "@/lib/ai/tools";
import { ptySessionManager } from "@/lib/ai/tools/utils/pty-session-manager";
import { generateTitleFromUserMessageWithWriter } from "@/lib/actions";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { assertUserCanMakeCostIncurringRequest } from "@/lib/suspensions";
import type {
  ChatMode,
  LimitRescueRequest,
  Todo,
  SandboxPreference,
  SelectedModel,
  RateLimitInfo,
} from "@/types";
import {
  canUseExtraUsage,
  coerceSelectedModel,
  isLimitRescueRequest,
  normalizeMaxModelForSubscription,
  normalizeSelectedModelOverrideForSubscription,
} from "@/types";
import { getBaseTodosForRequest } from "@/lib/utils/todo-utils";
import {
  acquireFreeRunConcurrencyLock,
  checkFreeMonthlyCostLimit,
  checkRateLimit,
  deductUsage,
  deductUsageDelta,
  addUsageDeductionDelta,
  createUsageSettlementState,
  getUsageSettlementInitialDeduction,
  getUnsettledUsagePoints,
  getPaidDailyFreeAllowanceStatus,
  paidDailyFreeAllowanceStatusToMetadata,
  recordPaidDailyFreeAllowanceCost,
  recordFreeMonthlyCost,
  replaceUsageSettlementState,
  reservePaidDailyFreeAllowanceRequest,
  shouldSettleUsageMidRun,
  type PaidDailyFreeAllowanceReservation,
  UsageRefundTracker,
} from "@/lib/rate-limit";
import {
  BudgetMonitor,
  captureBudgetSnapshot,
} from "@/lib/chat/budget-monitor";
import { UsageTracker } from "@/lib/usage-tracker";
import {
  getMaxTokensForSubscription,
  safeCountTokens,
} from "@/lib/token-utils";
import { ChatSDKError } from "@/lib/errors";
import PostHogClient from "@/app/posthog";
import {
  captureAgentBudgetAbort,
  captureAgentCompletionAnalytics,
  captureToolCalls,
  captureUsageCost,
  captureUsageSettlement,
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
  isContextUsageEnabled,
  SummarizationTracker,
  appendSystemReminderToLastUserMessage,
  injectNotesIntoMessages,
  assertFreeAgentGates,
  assertTemporaryChatAccess,
  buildExtraUsageConfig,
  estimatePreflightInputTokens,
  getRetryFallbackModel,
  isAutoModelSelectionForRetry,
  resolveServedModelForCostAccounting,
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
import { processChatMessages } from "@/lib/chat/chat-processor";
import { summarizeIncompleteToolParts } from "@/lib/chat/tool-abort-utils";
import {
  hasVisibleAssistantContent,
  shouldSkipAbortedMessageSave,
  shouldUseUpdateOnlyForAbortedSave,
} from "@/lib/chat/abort-persistence";
import { createTrackedProvider } from "@/lib/ai/providers";
import {
  getSandboxUploadFailureMetadata,
  uploadSandboxFiles,
  getUploadBasePath,
  rewriteSandboxFilePathsInMessages,
  stripLocalDesktopSourcePaths,
} from "@/lib/utils/sandbox-file-utils";
import {
  getEmptyProcessedMessagesCause,
  getEmptyProcessedMessagesMetadata,
} from "@/lib/utils/local-attachment-messages";
import { after } from "next/server";
import { createResumableStreamContext } from "resumable-stream";
import {
  writeUploadStartStatus,
  writeUploadCompleteStatus,
  writeAutoContinue,
} from "@/lib/utils/stream-writer-utils";
import { Id } from "@/convex/_generated/dataModel";
import { phLogger } from "@/lib/posthog/server";
import { PAID_FUNNEL_EVENTS } from "@/lib/analytics/paid-funnel";
import {
  capturePaidDailyFreeAllowanceServerEvent,
  createPaidDailyFreeAllowanceBudgetSnapshot,
  createPaidDailyFreeAllowanceRateLimitInfo,
  createPaidDailyFreeAllowanceUsageLogContext,
  getPaidDailyFreeAllowanceModel,
  getRateLimitErrorCapReason,
} from "@/lib/api/paid-daily-free-allowance-rescue";
import {
  extractErrorDetails,
  getProviderErrorCategory,
  getProviderStatusCode,
  getUserFriendlyProviderError,
} from "@/lib/utils/error-utils";
import {
  requireBooleanFlag,
  requireChatMessagesArray,
} from "@/lib/api/chat-request-validation";
import { isAgentMode } from "@/lib/utils/mode-helpers";
import {
  createAgentStream,
  initAgentStreamState,
  resetServedModelTelemetryForRetry,
  retryUsesDifferentModel,
  type AgentStreamContext,
} from "@/lib/api/agent-stream-runner";
import {
  assertLocalSandboxFallbackAllowed,
  getSandboxFallbackPromptReminder,
  prepareSandboxContextForPrompt,
  writeSandboxFallbackEvent,
} from "@/lib/ai/tools/utils/sandbox-fallback";
import {
  omitImageViewToolResultsForProviderRetry,
  omitTrailingStepStartAssistantMessage,
} from "@/lib/chat/multimodal-tool-result-recovery";
import {
  detectAssistantContentLoopFromParts,
  shouldRetryProviderStreamAfterInterruptedToolInput,
  shouldRetryProviderStreamWithFallback,
} from "@/lib/chat/agent-long-provider-retry";
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
      ReturnType<typeof createPreemptiveTimeout> | undefined;

    // Track usage deductions for refund on error
    const usageRefundTracker = new UsageRefundTracker();

    // Wide event logger for structured logging
    let chatLogger: ChatLogger | undefined;
    let outerChatId: string | undefined;
    let posthog: ReturnType<typeof PostHogClient> = null;
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
        temporary: rawTemporary,
        sandboxPreference,
        selectedModel: rawSelectedModel,
        isAutoContinue,
        useClientMessagesForRegenerate,
        limitRescue: rawLimitRescue,
      }: {
        messages: unknown;
        mode: ChatMode;
        chatId: string;
        todos?: Todo[];
        regenerate?: boolean;
        temporary?: unknown;
        sandboxPreference?: SandboxPreference;
        selectedModel?: string;
        isAutoContinue?: boolean;
        useClientMessagesForRegenerate?: boolean;
        limitRescue?: unknown;
      } = await req.json();
      const temporary = requireBooleanFlag("temporary", rawTemporary);
      outerChatId = chatId;

      const limitRescue: LimitRescueRequest | undefined = isLimitRescueRequest(
        rawLimitRescue,
      )
        ? rawLimitRescue
        : undefined;

      chatLogger = createChatLogger({ chatId, endpoint });
      chatLogger.setRequestDetails({
        mode,
        isTemporary: temporary,
        isRegenerate: !!regenerate,
      });
      const requestMessages = requireChatMessagesArray(messages);

      const { userId, subscription, organizationId, freeQuotaSubject } =
        await getUserIDAndPro(req);
      const freeUsageSubject = freeQuotaSubject ?? userId;
      let selectedModelOverride: SelectedModel | undefined =
        normalizeSelectedModelOverrideForSubscription(
          coerceSelectedModel(rawSelectedModel ?? null),
          subscription,
        );
      await assertUserCanMakeCostIncurringRequest(userId);
      usageRefundTracker.setUser(userId, subscription, organizationId);
      assertTemporaryChatAccess({
        isTemporary: temporary,
        subscription,
      });
      if (subscription === "free") {
        const lock = await acquireFreeRunConcurrencyLock(
          freeUsageSubject,
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
      });

      // Pre-emptive abort fires before Vercel's hard request timeout so we
      // can flush logs and refund usage; agent mode uses elapsedTimeExceeds.
      const userStopSignal = new AbortController();
      if (!isAgentMode(mode)) {
        preemptiveTimeout = createPreemptiveTimeout({
          chatId,
          endpoint,
          abortController: userStopSignal,
          requestId: req.headers.get("x-vercel-id") ?? undefined,
          userId,
        });
      }

      const userCustomization = await getUserCustomization({ userId });

      const fetched = await getMessagesByChatId({
        chatId,
        userId,
        subscription,
        newMessages: requestMessages,
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
        { isTemporary: temporary, regenerate },
      );

      const extraUsageConfig = await buildExtraUsageConfig({
        userId,
        subscription,
        userCustomization,
        organizationId,
      });
      const extraUsageAvailable = canUseExtraUsage(extraUsageConfig);
      selectedModelOverride =
        normalizeMaxModelForSubscription(selectedModelOverride, subscription, {
          extraUsageAvailable,
        }) ?? undefined;

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
          ? await checkRateLimit(
              userId,
              mode,
              subscription,
              undefined,
              undefined,
              undefined,
              undefined,
              freeQuotaSubject,
            )
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
          extraUsageAvailable,
          allowLocalDesktopFiles:
            isAgentMode(mode) && sandboxPreference === "desktop",
        });

      // Empty after processing → providers reject the request before the route can stream.
      if (!processedMessages || processedMessages.length === 0) {
        throw new ChatSDKError(
          "bad_request:api",
          getEmptyProcessedMessagesCause(truncatedMessages),
          getEmptyProcessedMessagesMetadata(truncatedMessages, {
            regenerate: !!regenerate,
            isAutoContinue: !!isAutoContinue,
            isTemporary: temporary,
            sandboxPreference,
          }),
        );
      }

      const notesEnabled =
        (subscription !== "free" || isAgentMode(mode)) &&
        (userCustomization?.include_notes ?? true);

      const estimatedInputTokens = await estimatePreflightInputTokens({
        mode,
        subscription,
        userId,
        selectedModel,
        userCustomization,
        temporary,
        truncatedMessages,
      });

      // PostHog client for analytics.
      posthog = PostHogClient();

      const fileCounts = countFileAttachments(truncatedMessages);
      const chatLogContext = {
        messageCount: truncatedMessages.length,
        estimatedInputTokens,
        isNewChat,
        fileCount: fileCounts.totalFiles,
        imageCount: fileCounts.imageCount,
        notesEnabled,
      };
      chatLogger.setChat(chatLogContext, selectedModel);

      let paidDailyFreeAllowanceReservation:
        PaidDailyFreeAllowanceReservation | undefined;
      let rateLimitInfo: RateLimitInfo;

      try {
        rateLimitInfo =
          freeAskRateLimitInfo ??
          (await checkRateLimit(
            userId,
            mode,
            subscription,
            estimatedInputTokens,
            extraUsageConfig,
            selectedModel,
            organizationId,
            freeQuotaSubject,
          ));
      } catch (error) {
        if (!(error instanceof ChatSDKError)) {
          throw error;
        }

        const capReason = getRateLimitErrorCapReason(error);
        if (capReason !== "monthly_exhausted") {
          if (limitRescue) {
            capturePaidDailyFreeAllowanceServerEvent({
              event: PAID_FUNNEL_EVENTS.paidDailyFreeAllowanceBlocked,
              userId,
              subscription,
              mode,
              chatId,
              endpoint,
              extra: {
                blocked_reason: "not_monthly_exhausted",
                cap_reason: capReason,
              },
            });
          }
          throw error;
        }

        const allowanceContext = {
          userId,
          subscription,
          mode,
          capReason,
          hasAttachments: fileCounts.totalFiles > 0,
        };
        const allowanceStatus =
          await getPaidDailyFreeAllowanceStatus(allowanceContext);
        const allowanceMetadata =
          paidDailyFreeAllowanceStatusToMetadata(allowanceStatus);
        error.metadata = {
          ...error.metadata,
          paidDailyFreeAllowance: allowanceMetadata,
        };

        if (!limitRescue) {
          throw error;
        }

        const allowanceReservation =
          await reservePaidDailyFreeAllowanceRequest(allowanceContext);
        error.metadata = {
          ...error.metadata,
          paidDailyFreeAllowance: paidDailyFreeAllowanceStatusToMetadata(
            allowanceReservation.status,
          ),
        };

        if (!allowanceReservation.allowed) {
          capturePaidDailyFreeAllowanceServerEvent({
            event: PAID_FUNNEL_EVENTS.paidDailyFreeAllowanceBlocked,
            userId,
            subscription,
            mode,
            chatId,
            endpoint,
            reservation: allowanceReservation,
            extra: {
              blocked_reason:
                allowanceReservation.blockReason ??
                allowanceReservation.status.unavailableReason,
              cap_reason: capReason,
            },
          });
          throw error;
        }

        paidDailyFreeAllowanceReservation = allowanceReservation;
        selectedModel = getPaidDailyFreeAllowanceModel(mode);
        chatLogger.setChat(chatLogContext, selectedModel);
        rateLimitInfo =
          createPaidDailyFreeAllowanceRateLimitInfo(allowanceReservation);
        capturePaidDailyFreeAllowanceServerEvent({
          event: PAID_FUNNEL_EVENTS.paidDailyFreeAllowanceStarted,
          userId,
          subscription,
          mode,
          chatId,
          endpoint,
          reservation: allowanceReservation,
          extra: {
            selected_model: selectedModel,
          },
        });
      }

      const freeMonthlyBudgetSnapshot =
        subscription === "free"
          ? await checkFreeMonthlyCostLimit(freeUsageSubject)
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
        isTemporary: temporary,
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
              extraUsageConfig,
              ...(paidDailyFreeAllowanceReservation && {
                paidDailyFreeAllowance: {
                  costLimitDollars:
                    paidDailyFreeAllowanceReservation.status.costLimitDollars,
                  resetTime: paidDailyFreeAllowanceReservation.status.resetTime,
                },
              }),
            });

            const {
              tools,
              ensureSandbox,
              getTodoManager,
              getFileAccumulator,
              sandboxManager,
              getSandboxSessionCost,
              setCurrentModelName,
              getToolsForModel,
            } = createTools(
              userId,
              chatId,
              writer,
              mode,
              userLocation,
              baseTodos,
              notesEnabled,
              temporary,
              assistantMessageId,
              sandboxPreference,
              process.env.CONVEX_SERVICE_ROLE_KEY,
              undefined, // appendMetadataStream
              (costDollars: number) => {
                usageTracker.providerCost += costDollars;
                usageTracker.nonModelCost += costDollars;
                chatLogger?.getBuilder().addToolCost(costDollars);
              },
              subscription,
              (info) => {
                chatLogger?.setSandboxBoot(info);
              },
              selectedModel,
            );

            // Helper to send file metadata via stream for resumable stream clients
            // Uses accumulated metadata directly - no DB query needed!
            const sendFileMetadataToStream = (
              fileMetadata: Array<{
                fileId: Id<"files">;
                name: string;
                mediaType: string;
                s3Key?: string;
                sizeBytes?: number;
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
            let sandboxFallbackReminder: string | null = null;
            if (isAgentMode(mode)) {
              const sandboxPromptContext = await prepareSandboxContextForPrompt(
                {
                  sandboxManager,
                  writer,
                  eventId: `sandbox-fallback-${assistantMessageId}`,
                  emitFallbackEvent: false,
                  onContextError: (error) => {
                    console.warn(
                      "Failed to get sandbox context for prompt:",
                      error,
                    );
                  },
                },
              );
              sandboxContext = sandboxPromptContext.sandboxContext;
              sandboxFallbackReminder = getSandboxFallbackPromptReminder(
                sandboxPromptContext.fallbackInfo,
              );
              try {
                assertLocalSandboxFallbackAllowed({
                  fallbackInfo: sandboxPromptContext.fallbackInfo,
                });
              } catch (error) {
                if (error instanceof ChatSDKError) {
                  preemptiveTimeout?.clear();
                  await usageRefundTracker.refund();
                  chatLogger?.emitChatError(error);
                }
                throw error;
              }
              if (sandboxPromptContext.fallbackInfo?.occurred) {
                writeSandboxFallbackEvent(
                  writer,
                  sandboxPromptContext.fallbackInfo,
                  `sandbox-fallback-${assistantMessageId}`,
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
                  { retryWithFreshSandboxOnTransientFailure: true },
                );
              } finally {
                writeUploadCompleteStatus(writer);
              }
              if (uploadResult.failedCount > 0) {
                const noun =
                  uploadResult.failedCount === 1 ? "attachment" : "attachments";
                const uploadError = new ChatSDKError(
                  "bad_request:sandbox",
                  `Failed to upload ${uploadResult.failedCount} ${noun} to the computer. Please try again.`,
                  getSandboxUploadFailureMetadata(uploadResult),
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

            const systemPromptTokens = safeCountTokens(currentSystemPrompt);

            const contextUsageOn = isContextUsageEnabled(subscription, mode);
            const ctxSystemTokens = contextUsageOn ? systemPromptTokens : 0;
            const ctxMaxTokens = contextUsageOn
              ? getMaxTokensForSubscription(subscription, { mode })
              : 0;
            // finalMessages will be set in prepareStep if summarization is needed
            let finalMessages = processedMessages;

            if (sandboxFallbackReminder) {
              finalMessages = appendSystemReminderToLastUserMessage(
                finalMessages,
                sandboxFallbackReminder,
              );
            }

            // Inject resume context into messages instead of system prompt
            // to keep the system prompt stable for caching
            const resumeContext = regenerate
              ? ""
              : getResumeSection(chat?.finish_reason);
            if (resumeContext) {
              finalMessages = appendSystemReminderToLastUserMessage(
                finalMessages,
                resumeContext,
              );
            }

            // Inject notes into messages instead of system prompt
            // to keep the system prompt stable for prompt caching
            const shouldIncludeNotes = userCustomization?.include_notes ?? true;
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
            const paidDailyFreeAllowanceBudgetSnapshot =
              paidDailyFreeAllowanceReservation
                ? createPaidDailyFreeAllowanceBudgetSnapshot(
                    paidDailyFreeAllowanceReservation,
                  )
                : null;
            const effectiveBudgetSnapshot =
              paidDailyFreeAllowanceBudgetSnapshot ??
              budgetSnapshot ??
              (freeMonthlyBudgetSnapshot?.rateLimitSkipped
                ? null
                : freeMonthlyBudgetSnapshot);
            const isReasoningModel = isAgentMode(mode);

            const streamStartTime = Date.now();
            const configuredModelId =
              trackedProvider.languageModel(selectedModel).modelId;
            const budgetMonitor = effectiveBudgetSnapshot
              ? new BudgetMonitor(
                  effectiveBudgetSnapshot,
                  writer,
                  subscription,
                  {
                    extraUsageConfig,
                  },
                )
              : null;

            let isRetryWithFallback = false;
            let retryUsedFallbackModel = false;
            const isAutoModel = isAutoModelSelectionForRetry({
              selectedModel,
              selectedModelOverride,
            });
            const fallbackModel = getRetryFallbackModel(selectedModel, mode);
            const fallbackModelId =
              trackedProvider.languageModel(fallbackModel).modelId;
            let activeModelName = selectedModel;

            const usageTracker = new UsageTracker();
            let hasRecordedUsage = false;
            // Snapshot cache tokens before fallback retry so we can isolate fallback-only metrics
            let preFallbackCacheRead = 0;
            let preFallbackCacheWrite = 0;
            const usageSettlementState =
              subscription === "free" || paidDailyFreeAllowanceReservation
                ? null
                : createUsageSettlementState(rateLimitInfo);
            let usageSettlementSequence = 0;

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
                const usageRecordArgs = {
                  selectedModel,
                  selectedModelOverride,
                  responseModel: state.responseModel,
                  configuredModelId,
                  accountingModel: resolveServedModelForCostAccounting({
                    modelName: activeModelName,
                    responseModel: state.responseModel,
                    mode,
                  }),
                  rateLimitInfo,
                };
                let usageCostRecord =
                  usageTracker.createUsageCostRecord(usageRecordArgs);

                // Trust accumulated provider cost only when every model step has
                // an authoritative cost. providerCost also includes tool/sandbox
                // spend; if any model step is missing cost, keep token fallback
                // for the model portion and add nonModelCost separately.
                const providerCost = usageTracker.hasAuthoritativeModelCost
                  ? usageTracker.providerCost
                  : undefined;

                if (paidDailyFreeAllowanceReservation) {
                  const allowanceCostRecord =
                    await recordPaidDailyFreeAllowanceCost(
                      userId,
                      usageCostRecord.costDollars,
                    );
                  if (!allowanceCostRecord.recorded) {
                    phLogger.warn(
                      "Paid daily free allowance cost recording failed",
                      {
                        userId,
                        chatId,
                        endpoint,
                        mode,
                        subscription,
                        selected_model: selectedModel,
                        cost_dollars: usageCostRecord.costDollars,
                        cost_record_failure_reason:
                          allowanceCostRecord.unavailableReason,
                      },
                    );
                  }
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
                    accountingModel: usageRecordArgs.accountingModel,
                    rateLimitInfo,
                  });
                  const cutOff = state.stoppedDueToBudgetExhaustion;
                  capturePaidDailyFreeAllowanceServerEvent({
                    event: cutOff
                      ? PAID_FUNNEL_EVENTS.paidDailyFreeAllowanceCutOff
                      : PAID_FUNNEL_EVENTS.paidDailyFreeAllowanceSucceeded,
                    userId,
                    subscription,
                    mode,
                    chatId,
                    endpoint,
                    reservation: paidDailyFreeAllowanceReservation,
                    extra: {
                      cost_dollars: usageCostRecord.costDollars,
                      model_cost_dollars: usageCostRecord.modelCostDollars,
                      non_model_cost_dollars:
                        usageCostRecord.nonModelCostDollars,
                      selected_model: selectedModel,
                      response_model: state.responseModel,
                      cost_source: usageCostRecord.costSource,
                      paid_daily_free_allowance_cost_recorded:
                        allowanceCostRecord.recorded,
                      paid_daily_free_allowance_cost_record_failure_reason:
                        allowanceCostRecord.recorded
                          ? undefined
                          : allowanceCostRecord.unavailableReason,
                      paid_daily_free_allowance_cost_record_next_dollars:
                        allowanceCostRecord.recorded
                          ? allowanceCostRecord.nextCostDollars
                          : undefined,
                    },
                  });
                } else if (subscription === "free") {
                  await recordFreeMonthlyCost(
                    freeUsageSubject,
                    usageCostRecord.costDollars,
                  );
                } else {
                  const deductionResult = await deductUsage(
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
                    usageSettlementState
                      ? getUsageSettlementInitialDeduction(usageSettlementState)
                      : rateLimitInfo,
                    usageRecordArgs.accountingModel,
                    usageTracker.usageSettlementId,
                  );
                  if (usageSettlementState) {
                    usageRefundTracker.recordDeductions({
                      ...rateLimitInfo,
                      pointsDeducted: deductionResult.includedPointsDeducted,
                      extraUsagePointsDeducted:
                        deductionResult.extraUsagePointsDeducted,
                    });
                    replaceUsageSettlementState(
                      usageSettlementState,
                      deductionResult,
                    );
                  }
                  if (deductionResult.uncoveredPoints > 0) {
                    state.stoppedDueToBudgetExhaustion = true;
                    if (state.streamFinishReason !== "error") {
                      state.streamFinishReason =
                        BUDGET_EXHAUSTION_FINISH_REASON;
                    }
                    phLogger.warn("Usage deduction left uncovered cost", {
                      chatId,
                      endpoint,
                      mode,
                      userId,
                      organizationId,
                      subscription,
                      selectedModel,
                      uncoveredPoints: deductionResult.uncoveredPoints,
                      usageDeductionFailureReason:
                        deductionResult.usageDeductionFailureReason,
                    });
                  }
                  const billingBreakdown =
                    deductionResult.includedPointsDeducted > 0 ||
                    deductionResult.extraUsagePointsDeducted > 0 ||
                    deductionResult.uncoveredPoints > 0 ||
                    deductionResult.usageDeductionFailed ||
                    !!deductionResult.usageDeductionFailureReason
                      ? deductionResult
                      : undefined;
                  usageCostRecord = usageTracker.createUsageCostRecord({
                    ...usageRecordArgs,
                    billingBreakdown,
                  });
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
                    accountingModel: usageRecordArgs.accountingModel,
                    rateLimitInfo,
                    billingBreakdown,
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
                  responseModel: state.responseModel,
                  ...(usageSettlementState && {
                    usageSettlement: {
                      id: usageTracker.usageSettlementId,
                      midRunCount: usageSettlementSequence,
                    },
                  }),
                  ...(paidDailyFreeAllowanceReservation && {
                    paidDailyFreeAllowance:
                      createPaidDailyFreeAllowanceUsageLogContext(
                        paidDailyFreeAllowanceReservation,
                        state.stoppedDueToBudgetExhaustion,
                      ),
                  }),
                });
              } finally {
                await releaseFreeRunLockOnce();
              }
            };

            const settleUsageAfterStep: AgentStreamContext["settleUsageAfterStep"] =
              async ({ currentCostDollars, force, model }) => {
                if (!usageSettlementState || hasRecordedUsage) return;
                if (
                  !shouldSettleUsageMidRun({
                    state: usageSettlementState,
                    currentCostDollars,
                    force,
                  })
                ) {
                  return;
                }

                const additionalCostPoints = getUnsettledUsagePoints(
                  usageSettlementState,
                  currentCostDollars,
                );
                if (additionalCostPoints <= 0) return;
                usageSettlementSequence += 1;

                let deductionResult: Awaited<
                  ReturnType<typeof deductUsageDelta>
                >;
                try {
                  deductionResult = await deductUsageDelta(
                    userId,
                    subscription,
                    additionalCostPoints,
                    extraUsageConfig,
                    organizationId,
                    usageTracker.usageSettlementId,
                  );
                } catch (error) {
                  phLogger.warn("Mid-run usage settlement failed", {
                    event: "mid_run_usage_settlement_failed",
                    chat_id: chatId,
                    endpoint,
                    mode,
                    user_id: userId,
                    organization_id: organizationId,
                    subscription,
                    selected_model: selectedModel,
                    additional_cost_points: additionalCostPoints,
                    usage_settlement_id: usageTracker.usageSettlementId,
                    current_cost_dollars: currentCostDollars,
                    force,
                    error_name:
                      error instanceof Error ? error.name : "UnknownError",
                  });
                  deductionResult = {
                    includedPointsDeducted: 0,
                    extraUsagePointsDeducted: 0,
                    uncoveredPoints: additionalCostPoints,
                    usageDeductionFailed: true,
                    usageDeductionFailureReason: "deduction_failed",
                  };
                }

                captureUsageSettlement({
                  posthog,
                  userId,
                  subscription,
                  organizationId,
                  chatId,
                  endpoint,
                  mode,
                  model,
                  requestId: req.headers.get("x-vercel-id") ?? undefined,
                  usageSettlementId: usageTracker.usageSettlementId,
                  settlementSequence: usageSettlementSequence,
                  currentCostDollars,
                  requestedDeltaPoints: additionalCostPoints,
                  deduction: deductionResult,
                  forced: force,
                });

                usageRefundTracker.addDeductions(deductionResult);
                const cumulativeDeduction = addUsageDeductionDelta(
                  usageSettlementState,
                  deductionResult,
                );
                if (cumulativeDeduction.uncoveredPoints <= 0) return;

                state.stoppedDueToBudgetExhaustion = true;
                if (state.streamFinishReason !== "error") {
                  state.streamFinishReason = BUDGET_EXHAUSTION_FINISH_REASON;
                }
                phLogger.warn("Mid-run usage settlement left uncovered cost", {
                  event: "mid_run_usage_settlement_uncovered",
                  chat_id: chatId,
                  endpoint,
                  mode,
                  user_id: userId,
                  organization_id: organizationId,
                  subscription,
                  selected_model: selectedModel,
                  additional_cost_points: additionalCostPoints,
                  current_cost_dollars: currentCostDollars,
                  included_points_deducted:
                    cumulativeDeduction.includedPointsDeducted,
                  extra_usage_points_deducted:
                    cumulativeDeduction.extraUsagePointsDeducted,
                  uncovered_points: cumulativeDeduction.uncoveredPoints,
                  usage_deduction_failure_reason:
                    cumulativeDeduction.usageDeductionFailureReason,
                  force,
                });
                userStopSignal.abort();
              };

            // Shared runner context.
            const streamCtx: AgentStreamContext = {
              trackedProvider,
              currentSystemPrompt,
              tools,
              mode,
              endpoint,
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
              settleUsageAfterStep,
              onBudgetAbort: (details) =>
                captureAgentBudgetAbort({
                  posthog,
                  userId,
                  subscription,
                  chatId,
                  endpoint,
                  mode,
                  selectedModel,
                  selectedModelOverride,
                  configuredModelId,
                  responseModel: state.responseModel,
                  isAutoContinue,
                  details,
                }),
              getHardTimeoutReason: () =>
                preemptiveTimeout?.isPreemptive() ? "timeout" : null,
            };

            const createStream = (modelName: string) => {
              activeModelName = modelName;
              streamCtx.tools = getToolsForModel(modelName);
              setCurrentModelName(modelName);
              return createAgentStream(modelName, streamCtx, state);
            };

            let result;
            try {
              result = await createStream(selectedModel);
            } catch (error) {
              // If provider returns an API error before streaming, retry with fallback.
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
                retryUsedFallbackModel = retryUsesDifferentModel(
                  selectedModel,
                  fallbackModel,
                );
                resetServedModelTelemetryForRetry(state);
                state.lastStepInputTokens = 0;
                state.stoppedDueToTokenExhaustion = false;
                state.stoppedDueToElapsedTimeout = false;
                state.stoppedDueToDoomLoop = false;
                state.stoppedDueToAssistantContentLoop = false;
                state.assistantContentLoopDetection = undefined;
                state.stoppedDueToBudgetExhaustion = false;
                state.stoppedDueToAgentRunSpendCap = false;
                state.stoppedDueToPostSummarizationIncomplete = false;
                state.postSummarizationContinuationActive = false;
                state.postSummarizationToolCallCount = 0;
                state.postSummarizationText = "";
                state.budgetAbortDetails = undefined;
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
                    return {
                      mode,
                      createdAt: streamStartTime,
                      generationStartedAt: streamStartTime,
                    };
                  }

                  if (part.type === "finish") {
                    return {
                      mode,
                      createdAt: streamStartTime,
                      generationStartedAt: streamStartTime,
                      generationTimeMs: Date.now() - streamStartTime,
                    };
                  }
                },
                onFinish: async ({ messages, isAborted }) => {
                  let retryScheduled = false;
                  try {
                    const lastAssistantMessage = messages
                      .slice()
                      .reverse()
                      .find((m) => m.role === "assistant");
                    const lastAssistantMessageParts =
                      lastAssistantMessage?.parts ?? [];
                    const assistantContentLoopDetection =
                      state.assistantContentLoopDetection ??
                      (isAborted
                        ? { detected: false as const }
                        : detectAssistantContentLoopFromParts(
                            lastAssistantMessageParts,
                          ));
                    const stoppedDueToAssistantContentLoop =
                      state.stoppedDueToAssistantContentLoop ||
                      (!isAborted && assistantContentLoopDetection.detected);
                    const hasTerminalProviderStreamError =
                      state.streamFinishReason === "error";
                    const shouldRetryInterruptedToolInput =
                      shouldRetryProviderStreamAfterInterruptedToolInput(
                        lastAssistantMessageParts,
                        { hasTerminalProviderStreamError },
                      );
                    const shouldRetryWithFallback =
                      shouldRetryProviderStreamWithFallback(
                        lastAssistantMessageParts,
                        {
                          hasTerminalProviderStreamError:
                            hasTerminalProviderStreamError,
                          stoppedDueToDoomLoop: state.stoppedDueToDoomLoop,
                          stoppedDueToAssistantContentLoop,
                          detectAssistantContentLoop: !isAborted,
                        },
                      );
                    const imageRecovery =
                      state.providerRejectedMultimodalToolResults
                        ? omitImageViewToolResultsForProviderRetry(messages)
                        : { messages, omittedCount: 0 };
                    const shouldRetryWithoutImageToolResults =
                      imageRecovery.omittedCount > 0 && !isAborted;

                    if (
                      shouldRetryWithFallback ||
                      shouldRetryWithoutImageToolResults
                    ) {
                      const loopTriggeredRetry =
                        stoppedDueToAssistantContentLoop ||
                        state.stoppedDueToDoomLoop;
                      const retryReason = shouldRetryWithoutImageToolResults
                        ? "image_tool_result_rejection"
                        : stoppedDueToAssistantContentLoop
                          ? "assistant_content_loop"
                          : state.stoppedDueToDoomLoop
                            ? "doom_loop"
                            : shouldRetryInterruptedToolInput
                              ? "interrupted_tool_input"
                              : "incomplete_stream";
                      phLogger.warn(
                        shouldRetryWithoutImageToolResults
                          ? "Provider rejected image tool output - retrying without images"
                          : retryReason === "assistant_content_loop"
                            ? "Assistant content loop detected - triggering fallback"
                            : retryReason === "doom_loop"
                              ? "Agent doom loop detected - triggering fallback"
                              : retryReason === "interrupted_tool_input"
                                ? "Provider stream errored during tool input - triggering bounded fallback"
                                : hasTerminalProviderStreamError
                                  ? "Provider stream errored before useful output - triggering fallback"
                                  : "Stream finished incomplete - triggering fallback",
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
                          retryReason,
                          stoppedDueToDoomLoop: state.stoppedDueToDoomLoop,
                          assistantContentLoop:
                            assistantContentLoopDetection.detected
                              ? assistantContentLoopDetection
                              : undefined,
                          shouldRetryInterruptedToolInput,
                          imageToolResultsOmitted: imageRecovery.omittedCount,
                        },
                      );

                      // Retry with fallback model for incomplete or reasoning-only
                      // terminal provider streams. For image-tool rejection, retry
                      // the same selected model after replacing image outputs with
                      // text placeholders.
                      if (
                        !isRetryWithFallback &&
                        (!isAborted || stoppedDueToAssistantContentLoop) &&
                        (isAutoModel ||
                          shouldRetryWithoutImageToolResults ||
                          loopTriggeredRetry ||
                          shouldRetryInterruptedToolInput)
                      ) {
                        isRetryWithFallback = true;
                        state.lastStepInputTokens = 0;
                        state.streamFinishReason = undefined;
                        state.providerError = undefined;
                        state.providerRejectedMultimodalToolResults = false;
                        state.stoppedDueToTokenExhaustion = false;
                        state.stoppedDueToElapsedTimeout = false;
                        state.stoppedDueToDoomLoop = false;
                        state.stoppedDueToAssistantContentLoop = false;
                        state.assistantContentLoopDetection = undefined;
                        state.stoppedDueToBudgetExhaustion = false;
                        state.stoppedDueToAgentRunSpendCap = false;
                        state.stoppedDueToPostSummarizationIncomplete = false;
                        state.postSummarizationContinuationActive = false;
                        state.postSummarizationToolCallCount = 0;
                        state.postSummarizationText = "";
                        state.budgetAbortDetails = undefined;
                        const fallbackStartTime = Date.now();
                        preFallbackCacheRead = usageTracker.cacheReadTokens;
                        preFallbackCacheWrite = usageTracker.cacheWriteTokens;

                        const retryModel = shouldRetryWithoutImageToolResults
                          ? selectedModel
                          : fallbackModel;
                        retryUsedFallbackModel = retryUsesDifferentModel(
                          selectedModel,
                          retryModel,
                        );
                        resetServedModelTelemetryForRetry(state);
                        if (shouldRetryWithoutImageToolResults) {
                          state.finalMessages =
                            omitTrailingStepStartAssistantMessage(
                              imageRecovery.messages,
                            );
                        } else {
                          // Discard the failed primary leg's model usage so the
                          // user is only billed for the fallback. Non-model spend
                          // (sandbox/tools) is preserved.
                          usageTracker.resetModelLeg();
                        }

                        const retryResult = await createStream(retryModel);
                        const retryMessageId = generateId();

                        writer.merge(
                          retryResult.toUIMessageStream({
                            generateMessageId: () => retryMessageId,
                            messageMetadata: ({ part }) => {
                              if (part.type === "start") {
                                return {
                                  mode,
                                  createdAt: fallbackStartTime,
                                  generationStartedAt: fallbackStartTime,
                                };
                              }

                              if (part.type === "finish") {
                                return {
                                  mode,
                                  createdAt: fallbackStartTime,
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
                                // Final reconciliation can change the finish
                                // reason to budget-exhausted; do it before
                                // analytics and persistence consume state.
                                await deductAccumulatedUsage();
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
                                  selectedModel,
                                  configuredModelId,
                                  responseModel: state.responseModel,
                                  fallbackServed:
                                    state.responseModel &&
                                    retryUsedFallbackModel
                                      ? true
                                      : state.fallbackServed,
                                  finishReason: state.streamFinishReason,
                                  budgetAbortDetails: state.budgetAbortDetails,
                                });
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
                                  fallbackModel: retryModel,
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
                                  retryReason,
                                  imageToolResultsOmitted:
                                    imageRecovery.omittedCount,
                                });

                                shutdownPostHog(posthog);
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
                    const cleanupRequestId =
                      req.headers.get("x-request-id") ??
                      req.headers.get("x-vercel-id") ??
                      undefined;

                    const logCleanupStage = ({
                      phase,
                      step,
                      stepStartTime,
                    }: {
                      phase: "started" | "completed";
                      step: string;
                      stepStartTime: number;
                    }) => {
                      if (!isPreemptiveAbort) return;

                      console.info(
                        JSON.stringify({
                          timestamp: new Date().toISOString(),
                          level: "info",
                          event: "preemptive_timeout_cleanup_stage",
                          service: "chat-handler",
                          environment:
                            process.env.VERCEL_ENV ??
                            process.env.NODE_ENV ??
                            "unknown",
                          request_id: cleanupRequestId,
                          user_id: userId,
                          chat_id: chatId,
                          endpoint,
                          phase,
                          stage: step,
                          stage_duration_ms:
                            phase === "completed"
                              ? Date.now() - stepStartTime
                              : undefined,
                          elapsed_since_timeout_ms: triggerTime
                            ? Date.now() - triggerTime
                            : null,
                        }),
                      );
                    };

                    const beginStep = (step: string): number => {
                      const stepStartTime = Date.now();
                      logCleanupStage({
                        phase: "started",
                        step,
                        stepStartTime,
                      });
                      return stepStartTime;
                    };

                    // Helper to log step timing during preemptive timeout
                    const logStep = (step: string, stepStartTime: number) => {
                      if (isPreemptiveAbort) {
                        logCleanupStage({
                          phase: "completed",
                          step,
                          stepStartTime,
                        });
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
                    let stepStart = beginStep("clear_timeout");
                    preemptiveTimeout?.clear();
                    logStep("clear_timeout", stepStart);

                    // Stop cancellation subscriber
                    stepStart = beginStep("stop_cancellation_subscriber");
                    await cancellationSubscriber.stop();
                    subscriberStopped = true;
                    logStep("stop_cancellation_subscriber", stepStart);

                    // Clear finish reason for user-initiated aborts (not pre-emptive timeouts)
                    // This prevents showing "going off course" message when user clicks stop
                    if (
                      isAborted &&
                      !isPreemptiveAbort &&
                      !state.stoppedDueToBudgetExhaustion &&
                      !state.stoppedDueToAgentRunSpendCap
                    ) {
                      state.streamFinishReason = undefined;
                    }

                    // Emit wide event
                    stepStart = beginStep("settle_usage_and_emit_success");
                    const sandboxInfo = sandboxManager.getSandboxInfo();
                    chatLogger!.setSandbox(sandboxInfo);
                    chatLogger!.setCacheMetrics({
                      cacheHitRate: usageTracker.cacheHitRate,
                      cacheReadTokens: usageTracker.cacheReadTokens,
                      cacheWriteTokens: usageTracker.cacheWriteTokens,
                    });
                    captureToolCalls({ posthog, chatLogger, userId, mode });
                    // Final reconciliation can change the finish reason to
                    // budget-exhausted; do it before analytics and persistence
                    // consume state.
                    await deductAccumulatedUsage();
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
                      selectedModel,
                      configuredModelId,
                      responseModel: state.responseModel,
                      fallbackServed:
                        state.responseModel && retryUsedFallbackModel
                          ? true
                          : state.fallbackServed,
                      finishReason: state.streamFinishReason,
                      budgetAbortDetails: state.budgetAbortDetails,
                    });
                    chatLogger!.emitSuccess({
                      finishReason: state.streamFinishReason,
                      wasAborted: isAborted,
                      wasPreemptiveTimeout: isPreemptiveAbort,
                      hadSummarization: summarizationTracker.hasSummarized,
                    });
                    logStep("settle_usage_and_emit_success", stepStart);

                    // Sandbox cleanup is automatic with auto-pause
                    // The sandbox will auto-pause after inactivity timeout (7 minutes)
                    // No manual pause needed

                    // Always wait for title generation to complete
                    stepStart = beginStep("wait_title_generation");
                    const generatedTitle = await titlePromise;
                    logStep("wait_title_generation", stepStart);

                    if (!temporary) {
                      stepStart = beginStep("merge_todos");
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
                        stepStart = beginStep("update_chat");
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
                        stepStart = beginStep("prepare_for_new_stream");
                        await prepareForNewStream({ chatId });
                        logStep("prepare_for_new_stream", stepStart);
                      }

                      stepStart = beginStep("get_accumulated_files");
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
                        stepStart = beginStep("resolve_stream_usage");
                        try {
                          resolvedUsage = (await result.usage) as Record<
                            string,
                            unknown
                          >;
                        } catch {
                          // Usage unavailable on abort - continue without it
                        } finally {
                          logStep("resolve_stream_usage", stepStart);
                        }
                      }

                      const hasUsageToRecord = Boolean(resolvedUsage);
                      const shouldSkipSaveSignal =
                        cancellationSubscriber.shouldSkipSave();
                      const isUserInitiatedAbort =
                        isAborted &&
                        !isPreemptiveAbort &&
                        !state.stoppedDueToBudgetExhaustion &&
                        !state.stoppedDueToAgentRunSpendCap &&
                        !state.stoppedDueToElapsedTimeout;
                      const hasAssistantContentToSave =
                        hasVisibleAssistantContent(messages);

                      // If aborted, skip message save only when:
                      // 1. skipSave signal received via Redis (edit/regenerate/retry — message will be discarded)
                      // 2. No assistant content, files, tools, or usage need backend persistence
                      if (
                        !isPreemptiveAbort &&
                        shouldSkipAbortedMessageSave({
                          isAborted,
                          shouldSkipSaveSignal,
                          hasVisibleAssistantContent: hasAssistantContentToSave,
                          hasNewFiles: newFileIds.length > 0,
                          hasIncompleteToolCalls,
                          hasUsageToRecord,
                        })
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
                            has_visible_assistant_content:
                              hasAssistantContentToSave,
                            has_incomplete_tool_calls: hasIncompleteToolCalls,
                            has_usage_to_record: hasUsageToRecord,
                          }),
                        );
                        await deductAccumulatedUsage();
                        shutdownPostHog(posthog);
                        return;
                      }

                      // Save messages (either full save or just append extraFileIds)
                      stepStart = beginStep("save_messages");
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
                        // On explicit user stop, use updateOnly as safety net:
                        // only patch existing messages (add files/usage), don't create new ones.
                        // Budget/provider/system aborts must insert partial work if no row exists.
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
                            updateOnly: shouldUseUpdateOnlyForAbortedSave({
                              isAborted,
                              isUserInitiatedAbort,
                            })
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
                      stepStart = beginStep("send_file_metadata");
                      sendFileMetadataToStream(accumulatedFiles);
                      logStep("send_file_metadata", stepStart);
                    } else {
                      // For temporary chats, send file metadata via stream before cleanup
                      stepStart = beginStep("send_temp_file_metadata");
                      const tempFiles = getFileAccumulator().getAll();
                      sendFileMetadataToStream(tempFiles);
                      logStep("send_temp_file_metadata", stepStart);

                      // Ensure temp stream row is removed backend-side
                      stepStart = beginStep("delete_temp_stream");
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
                      stepStart = beginStep("flush_telemetry");
                      await phLogger.flush();
                      logStep("flush_telemetry", stepStart);
                    }

                    const autoContinueStopSource =
                      getAgentAutoContinueStopSource({
                        finishReason: state.streamFinishReason,
                        stoppedDueToTokenExhaustion:
                          state.stoppedDueToTokenExhaustion,
                        stoppedDueToElapsedTimeout:
                          state.stoppedDueToElapsedTimeout,
                        stoppedDueToPostSummarizationIncomplete:
                          state.stoppedDueToPostSummarizationIncomplete,
                      });
                    if (
                      autoContinueStopSource &&
                      isAgentMode(mode) &&
                      !temporary
                    ) {
                      writeAutoContinue(writer);
                      phLogger.info("Agent auto-continue signaled", {
                        event: "agent_auto_continue_signaled",
                        chat_id: chatId,
                        assistant_id: assistantMessageId,
                        finish_reason: state.streamFinishReason,
                        stop_source: autoContinueStopSource,
                        last_step_input_tokens: state.lastStepInputTokens,
                        had_summarization: summarizationTracker.hasSummarized,
                      });
                    }
                    shutdownPostHog(posthog);
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
      shutdownPostHog(posthog);

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

      const providerDetails = extractErrorDetails(error);
      const providerErrorCategory = getProviderErrorCategory(providerDetails);
      const providerStatusCode = getProviderStatusCode(providerDetails);
      const isContentBlocked = providerErrorCategory === "content_blocked";
      const unexpectedError = new ChatSDKError(
        isContentBlocked ? "forbidden:stream" : "bad_request:stream",
        getUserFriendlyProviderError(error),
        {
          providerErrorCategory,
          providerStatusCode,
          providerErrorRetriable:
            providerErrorCategory === "rate_limited" ||
            providerErrorCategory === "provider_5xx" ||
            providerErrorCategory === "stream_terminated" ||
            providerErrorCategory === "timeout",
        },
      );
      return unexpectedError.toResponse();
    }
  };
};
