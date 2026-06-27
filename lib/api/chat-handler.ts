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
  LimitRescueRequest,
  Todo,
  SandboxPreference,
  SelectedModel,
  RateLimitInfo,
  SandboxBootInfo,
} from "@/types";
import {
  coerceSelectedModel,
  isLimitRescueRequest,
  normalizeSelectedModelOverrideForSubscription,
} from "@/types";
import { getBaseTodosForRequest } from "@/lib/utils/todo-utils";
import {
  acquireFreeRunConcurrencyLock,
  checkFreeMonthlyCostLimit,
  checkRateLimit,
  deductUsage,
  getPaidDailyFreeAllowanceStatus,
  paidDailyFreeAllowanceStatusToMetadata,
  recordPaidDailyFreeAllowanceCost,
  recordFreeMonthlyCost,
  reservePaidDailyFreeAllowanceRequest,
  type PaidDailyFreeAllowanceReservation,
  UsageRefundTracker,
} from "@/lib/rate-limit";
import {
  BudgetMonitor,
  captureBudgetSnapshot,
  getProAgentRunSpendCap,
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
  createChatLogger,
  shutdownPostHog,
  type ChatLogger,
} from "@/lib/api/chat-logger";
import { captureAgentRunSpendCapHit } from "@/lib/chat/agent-run-spend-cap-analytics";
import { resolveAgentRunSpendCapContinuationModel } from "@/lib/chat/agent-run-spend-cap";
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
  buildExtraUsageConfig,
  estimatePreflightInputTokens,
  getRetryFallbackModel,
  isAutoModelSelectionForRetry,
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
import { getMaxStepsForUser } from "@/lib/chat/chat-processor";
import { phLogger } from "@/lib/posthog/server";
import { PAID_FUNNEL_EVENTS } from "@/lib/analytics/paid-funnel";
import {
  PAID_DAILY_FREE_ALLOWANCE_MODEL,
  capturePaidDailyFreeAllowanceServerEvent,
  createPaidDailyFreeAllowanceBudgetSnapshot,
  createPaidDailyFreeAllowanceRateLimitInfo,
  createPaidDailyFreeAllowanceUsageLogContext,
  getRateLimitErrorCapReason,
} from "@/lib/api/paid-daily-free-allowance-rescue";
import {
  extractErrorDetails,
  getProviderErrorCategory,
  getProviderStatusCode,
  getUserFriendlyProviderError,
} from "@/lib/utils/error-utils";
import { requireChatMessagesArray } from "@/lib/api/chat-request-validation";
import { isAgentMode } from "@/lib/utils/mode-helpers";
import {
  createAgentStream,
  initAgentStreamState,
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
import { shouldRetryProviderStreamWithFallback } from "@/lib/chat/agent-long-provider-retry";
import { FREE_RUN_LOCK_TTL_SECONDS } from "@/lib/rate-limit/free-config";
import {
  captureFreeAskReasoningExperimentExposure,
  captureFreeAskReasoningExperimentResult,
  resolveFreeAskReasoningExperiment,
} from "@/lib/experiments/free-ask-reasoning";

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
    let posthog: ReturnType<typeof PostHogClient> = null;
    let freeAskReasoningExperiment: Awaited<
      ReturnType<typeof resolveFreeAskReasoningExperiment>
    > = null;
    let freeAskReasoningResultContext: {
      userId: string;
      chatId: string;
      subscription: string;
      mode: ChatMode;
      selectedModel: string;
    } | null = null;
    let freeAskReasoningResultRecorded = false;
    let releaseFreeRunLock: (() => Promise<void>) | undefined;
    const releaseFreeRunLockOnce = async () => {
      const release = releaseFreeRunLock;
      if (!release) return;
      releaseFreeRunLock = undefined;
      await release();
    };
    const captureFreeAskReasoningTerminalResult = ({
      outcome,
      generationTimeMs,
      finishReason,
    }: {
      outcome: "success" | "aborted" | "error";
      generationTimeMs?: number;
      finishReason?: string;
    }) => {
      if (
        !freeAskReasoningResultContext ||
        !freeAskReasoningExperiment ||
        freeAskReasoningResultRecorded
      ) {
        return;
      }

      captureFreeAskReasoningExperimentResult({
        posthog,
        ...freeAskReasoningResultContext,
        assignment: freeAskReasoningExperiment,
        outcome,
        generationTimeMs,
        finishReason,
      });
      freeAskReasoningResultRecorded = true;
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
        limitRescue: rawLimitRescue,
      }: {
        messages: unknown;
        mode: ChatMode;
        chatId: string;
        todos?: Todo[];
        regenerate?: boolean;
        temporary?: boolean;
        sandboxPreference?: SandboxPreference;
        selectedModel?: string;
        isAutoContinue?: boolean;
        useClientMessagesForRegenerate?: boolean;
        limitRescue?: unknown;
      } = await req.json();
      outerChatId = chatId;

      const limitRescue: LimitRescueRequest | undefined = isLimitRescueRequest(
        rawLimitRescue,
      )
        ? rawLimitRescue
        : undefined;

      chatLogger = createChatLogger({ chatId, endpoint });
      chatLogger.setRequestDetails({
        mode,
        isTemporary: !!temporary,
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
        { isTemporary: !!temporary, regenerate },
      );

      const extraUsageConfig = await buildExtraUsageConfig({
        userId,
        subscription,
        userCustomization,
        organizationId,
      });

      selectedModelOverride = resolveAgentRunSpendCapContinuationModel({
        finishReason: chat?.finish_reason,
        isAutoContinue,
        mode,
        subscription,
        selectedModelOverride,
        extraUsageConfig,
      });

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
          allowLocalDesktopFiles:
            isAgentMode(mode) && sandboxPreference === "desktop",
        });

      // Empty after processing → Gemini rejects with "must include at least one parts field".
      if (!processedMessages || processedMessages.length === 0) {
        throw new ChatSDKError(
          "bad_request:api",
          getEmptyProcessedMessagesCause(truncatedMessages),
          getEmptyProcessedMessagesMetadata(truncatedMessages, {
            regenerate: !!regenerate,
            isAutoContinue: !!isAutoContinue,
            isTemporary: !!temporary,
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

      // PostHog client for analytics and server-side experiment evaluation.
      posthog = PostHogClient();

      const fileCounts = countFileAttachments(truncatedMessages);
      const eligibilityFileCounts = countFileAttachments(
        fetched.truncatedMessages,
      );
      freeAskReasoningExperiment = await resolveFreeAskReasoningExperiment({
        posthog,
        userId,
        subscription,
        mode,
        selectedModel,
        fileCount: eligibilityFileCounts.totalFiles,
      });
      freeAskReasoningResultContext = freeAskReasoningExperiment
        ? {
            userId,
            chatId,
            subscription,
            mode,
            selectedModel,
          }
        : null;
      const chatLogContext = {
        messageCount: truncatedMessages.length,
        estimatedInputTokens,
        isNewChat,
        fileCount: fileCounts.totalFiles,
        imageCount: fileCounts.imageCount,
        notesEnabled,
      };
      chatLogger.setChat(chatLogContext, selectedModel);
      captureFreeAskReasoningExperimentExposure({
        posthog,
        userId,
        chatId,
        subscription,
        mode,
        selectedModel,
        assignment: freeAskReasoningExperiment,
        estimatedInputTokens,
        isNewChat,
      });

      let paidDailyFreeAllowanceReservation:
        | PaidDailyFreeAllowanceReservation
        | undefined;
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
        selectedModel = PAID_DAILY_FREE_ALLOWANCE_MODEL;
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
              extraUsageConfig,
            });

            let uploadSandboxBootPath: SandboxBootInfo["path"] | null = null;
            const {
              tools,
              getSandbox,
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
              (info) => {
                uploadSandboxBootPath ??= info.path;
                chatLogger?.setSandboxBoot(info);
              },
              (info) => chatLogger?.setCaidoReady(info),
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
                  {
                    retryWithFreshSandboxOnTransientFailure: () =>
                      uploadSandboxBootPath === "reuse_existing",
                  },
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
            const agentRunSpendCap = getProAgentRunSpendCap({
              snapshot: effectiveBudgetSnapshot,
              subscription,
              mode,
            });
            const budgetMonitor = effectiveBudgetSnapshot
              ? new BudgetMonitor(
                  effectiveBudgetSnapshot,
                  writer,
                  subscription,
                  {
                    agentRunSpendCap,
                    extraUsageConfig,
                    onAgentRunSpendCapHit: (hit) => {
                      captureAgentRunSpendCapHit({
                        userId,
                        subscription,
                        mode,
                        chatId,
                        endpoint,
                        selectedModel,
                        selectedModelOverride,
                        configuredModelSlug: configuredModelId,
                        hit,
                      });
                    },
                  },
                )
              : null;

            let isRetryWithFallback = false;
            const isAutoModel = isAutoModelSelectionForRetry({
              selectedModel,
              selectedModelOverride,
            });
            const fallbackModel = getRetryFallbackModel(selectedModel, mode);
            const fallbackModelId =
              trackedProvider.languageModel(fallbackModel).modelId;
            const activeFreeAskReasoningExperiment =
              selectedModel === "ask-model-free" &&
              freeAskReasoningResultContext?.selectedModel === selectedModel
                ? freeAskReasoningExperiment
                : null;

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
                const usageRecordArgs = {
                  selectedModel,
                  selectedModelOverride,
                  responseModel: state.responseModel,
                  configuredModelId,
                  rateLimitInfo,
                };
                let usageCostRecord =
                  usageTracker.createUsageCostRecord(usageRecordArgs);

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
                    rateLimitInfo,
                  );
                  const billingBreakdown =
                    deductionResult.includedPointsDeducted > 0 ||
                    deductionResult.extraUsagePointsDeducted > 0
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
                  freeAskReasoningExperiment: activeFreeAskReasoningExperiment,
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
              ...(activeFreeAskReasoningExperiment?.reasoning.enabled && {
                providerReasoningOverride: {
                  modelName: selectedModel,
                  reasoning: activeFreeAskReasoningExperiment.reasoning,
                },
              }),
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
              streamCtx.tools = getToolsForModel(modelName);
              setCurrentModelName(modelName);
              return createAgentStream(modelName, streamCtx, state);
            };

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
                state.stoppedDueToAgentRunSpendCap = false;
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
                    const shouldRetryWithFallback =
                      shouldRetryProviderStreamWithFallback(
                        lastAssistantMessageParts,
                        {
                          hasTerminalProviderStreamError:
                            state.streamFinishReason === "error",
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
                      phLogger.warn(
                        shouldRetryWithoutImageToolResults
                          ? "Provider rejected image tool output - retrying without images"
                          : state.streamFinishReason === "error"
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
                          imageToolResultsOmitted: imageRecovery.omittedCount,
                        },
                      );

                      // Retry with fallback model for incomplete or reasoning-only
                      // terminal provider streams. For image-tool rejection, retry
                      // the same selected model after replacing image outputs with
                      // text placeholders.
                      if (
                        !isRetryWithFallback &&
                        !isAborted &&
                        (isAutoModel || shouldRetryWithoutImageToolResults)
                      ) {
                        isRetryWithFallback = true;
                        state.lastStepInputTokens = 0;
                        state.streamFinishReason = undefined;
                        state.providerError = undefined;
                        state.providerRejectedMultimodalToolResults = false;
                        state.stoppedDueToTokenExhaustion = false;
                        state.stoppedDueToElapsedTimeout = false;
                        state.stoppedDueToDoomLoop = false;
                        state.stoppedDueToBudgetExhaustion = false;
                        state.stoppedDueToAgentRunSpendCap = false;
                        state.budgetAbortDetails = undefined;
                        const fallbackStartTime = Date.now();
                        preFallbackCacheRead = usageTracker.cacheReadTokens;
                        preFallbackCacheWrite = usageTracker.cacheWriteTokens;

                        const retryModel = shouldRetryWithoutImageToolResults
                          ? selectedModel
                          : fallbackModel;
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
                                  retryReason:
                                    shouldRetryWithoutImageToolResults
                                      ? "image_tool_result_rejection"
                                      : "incomplete_stream",
                                  imageToolResultsOmitted:
                                    imageRecovery.omittedCount,
                                });

                                // Deduct accumulated usage (includes both original + retry streams)
                                await deductAccumulatedUsage();
                                captureFreeAskReasoningTerminalResult({
                                  outcome,
                                  generationTimeMs:
                                    Date.now() - streamStartTime,
                                  finishReason: state.streamFinishReason,
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
                    if (
                      isAborted &&
                      !isPreemptiveAbort &&
                      !state.stoppedDueToBudgetExhaustion &&
                      !state.stoppedDueToAgentRunSpendCap
                    ) {
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
                      finishReason: state.streamFinishReason,
                      budgetAbortDetails: state.budgetAbortDetails,
                    });
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
                        captureFreeAskReasoningTerminalResult({
                          outcome,
                          generationTimeMs: Date.now() - streamStartTime,
                          finishReason: state.streamFinishReason,
                        });
                        shutdownPostHog(posthog);
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
                    captureFreeAskReasoningTerminalResult({
                      outcome,
                      generationTimeMs: Date.now() - streamStartTime,
                      finishReason: state.streamFinishReason,
                    });
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
      captureFreeAskReasoningTerminalResult({ outcome: "error" });
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
