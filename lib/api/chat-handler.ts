import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateId,
  UIMessage,
} from "ai";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import type {
  ChatMode,
  Todo,
  SandboxPreference,
  ExtraUsageConfig,
  SelectedModel,
} from "@/types";
import { isSelectedModel } from "@/types";
import { getBaseTodosForRequest } from "@/lib/utils/todo-utils";
import { checkRateLimit, UsageRefundTracker } from "@/lib/rate-limit";
import { getExtraUsageBalance } from "@/lib/extra-usage";
import { countMessagesTokens } from "@/lib/token-utils";
import { ChatSDKError } from "@/lib/errors";
import { createChatLogger, type ChatLogger } from "@/lib/api/chat-logger";
import { countFileAttachments } from "@/lib/api/chat-stream-helpers";
import { createAgentStreamExecute } from "@/lib/api/agent-stream-core";
import { geolocation } from "@vercel/functions";
import { NextRequest } from "next/server";
import {
  handleInitialChatAndUserMessage,
  getMessagesByChatId,
  getUserCustomization,
  startStream,
  startTempStream,
} from "@/lib/db/actions";
import { createPreemptiveTimeout } from "@/lib/utils/stream-cancellation";
import { v4 as uuidv4 } from "uuid";
import { processChatMessages } from "@/lib/chat/chat-processor";
import { getUploadBasePath } from "@/lib/utils/sandbox-file-utils";
import { after } from "next/server";
import { createResumableStreamContext } from "resumable-stream";
import { nextJsAxiomLogger } from "@/lib/axiom/server";
import { getUserFriendlyProviderError } from "@/lib/utils/error-utils";
import { isAgentMode } from "@/lib/utils/mode-helpers";

function getStreamContext() {
  try {
    return createResumableStreamContext({ waitUntil: after });
  } catch (_) {
    return null;
  }
}

export { getStreamContext };

export const createChatHandler = (
  endpoint: "/api/chat" | "/api/agent" = "/api/chat",
) => {
  return async (req: NextRequest) => {
    let preemptiveTimeout:
      | ReturnType<typeof createPreemptiveTimeout>
      | undefined;

    // Track usage deductions for refund on error
    const usageRefundTracker = new UsageRefundTracker();

    // Wide event logger for structured logging
    let chatLogger: ChatLogger | undefined;

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
      } = await req.json();

      const selectedModelOverride: SelectedModel | undefined =
        rawSelectedModel && isSelectedModel(rawSelectedModel)
          ? rawSelectedModel
          : undefined;

      // Initialize chat logger
      chatLogger = createChatLogger({ chatId, endpoint });
      chatLogger.setRequestDetails({
        mode,
        isTemporary: !!temporary,
        isRegenerate: !!regenerate,
      });

      const { userId, subscription, organizationId } =
        await getUserIDAndPro(req);
      usageRefundTracker.setUser(userId, subscription);
      const userLocation = geolocation(req);

      // Add user context to logger (only region, not full location for privacy)
      chatLogger.setUser({
        id: userId,
        subscription,
        region: userLocation?.region,
      });

      if (isAgentMode(mode) && subscription === "free") {
        throw new ChatSDKError(
          "forbidden:chat",
          "Agent mode is only available for Pro users. Please upgrade to access this feature.",
        );
      }

      // Set up pre-emptive abort before Vercel timeout (moved early to cover entire request)
      const userStopSignal = new AbortController();
      preemptiveTimeout = createPreemptiveTimeout({
        chatId,
        endpoint,
        abortController: userStopSignal,
      });

      const { truncatedMessages, chat, isNewChat, fileTokens } =
        await getMessagesByChatId({
          chatId,
          userId,
          subscription,
          newMessages: messages,
          regenerate,
          isTemporary: temporary,
          mode,
        });

      const baseTodos: Todo[] = getBaseTodosForRequest(
        (chat?.todos as unknown as Todo[]) || [],
        Array.isArray(todos) ? todos : [],
        { isTemporary: !!temporary, regenerate },
      );

      if (!temporary) {
        await handleInitialChatAndUserMessage({
          chatId,
          userId,
          messages: truncatedMessages,
          regenerate,
          chat,
          isHidden: isAutoContinue ? true : undefined,
        });
      }

      // Free users in ask mode: check rate limit early (sliding window, no token counting needed)
      // This avoids unnecessary processing if they're over the limit
      const freeAskRateLimitInfo =
        mode === "ask" && subscription === "free"
          ? await checkRateLimit(userId, mode, subscription)
          : null;

      const uploadBasePath = isAgentMode(mode)
        ? getUploadBasePath(sandboxPreference)
        : undefined;

      const { processedMessages, selectedModel, sandboxFiles } =
        await processChatMessages({
          messages: truncatedMessages,
          mode,
          subscription,
          uploadBasePath,
          modelOverride: selectedModelOverride,
        });

      // Validate that we have at least one message with content after processing
      // This prevents "must include at least one parts field" errors from providers like Gemini
      if (!processedMessages || processedMessages.length === 0) {
        throw new ChatSDKError(
          "bad_request:api",
          "Your message could not be processed. Please include some text with your file attachments and try again.",
        );
      }

      // Fetch user customization early (needed for memory settings)
      const userCustomization = await getUserCustomization({ userId });
      const memoryEnabled =
        subscription !== "free" &&
        (userCustomization?.include_memory_entries ?? true);

      // Agent mode and paid ask mode: check rate limit with model-specific pricing after knowing the model
      // Token bucket requires estimated token count for cost calculation
      // Note: File tokens are not included because counts are inaccurate (especially PDFs)
      // and deductUsage reconciles with actual provider cost anyway
      const estimatedInputTokens =
        isAgentMode(mode) || subscription !== "free"
          ? countMessagesTokens(truncatedMessages)
          : 0;

      // Add chat context to logger
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

      // Build extra usage config (paid users only, works for both agent and ask modes)
      // extra_usage_enabled is in userCustomization, balance is in extra_usage
      let extraUsageConfig: ExtraUsageConfig | undefined;
      if (subscription !== "free") {
        const extraUsageEnabled =
          userCustomization?.extra_usage_enabled ?? false;

        if (extraUsageEnabled) {
          const balanceInfo = await getExtraUsageBalance(userId);

          if (!balanceInfo) {
            // Balance check failed (Convex error) — use optimistic config so
            // the rate limiter still attempts the deduction, which is the real
            // source of truth. Without this, a transient Convex failure silently
            // disables extra usage and the user hits the hard subscription limit.
            console.warn(
              `[chat-handler] getExtraUsageBalance returned null for user ${userId}, using optimistic extra usage config`,
            );
            extraUsageConfig = {
              enabled: true,
              hasBalance: true,
              autoReloadEnabled: false,
            };
          } else if (
            balanceInfo.balanceDollars > 0 ||
            balanceInfo.autoReloadEnabled
          ) {
            extraUsageConfig = {
              enabled: true,
              hasBalance: balanceInfo.balanceDollars > 0,
              balanceDollars: balanceInfo.balanceDollars,
              autoReloadEnabled: balanceInfo.autoReloadEnabled,
            };
          }
        }
      }

      const rateLimitInfo =
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

      // Track deductions for potential refund on error
      usageRefundTracker.recordDeductions(rateLimitInfo);

      // Add rate limit and extra usage context to logger
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

      // Start temp stream coordination for temporary chats
      if (temporary) {
        try {
          await startTempStream({ chatId, userId });
        } catch {
          // Silently continue; temp coordination is best-effort
        }
      }

      // Normalize fileTokens to Record<string, number>
      const normalizedFileTokens: Record<string, number> =
        typeof fileTokens === "number" ? {} : fileTokens;

      // Start stream timing
      chatLogger.startStream();

      const { execute } = createAgentStreamExecute({
        chatId,
        userId,
        subscription,
        mode,
        assistantMessageId,
        endpoint,
        processedMessages,
        selectedModel,
        selectedModelOverride,
        temporary: !!temporary,
        regenerate: !!regenerate,
        isNewChat,
        memoryEnabled,
        isAutoContinue,
        rateLimitInfo,
        baseTodos,
        sandboxPreference: sandboxPreference ?? "e2b",
        userLocation: userLocation ?? {
          region: undefined,
          city: undefined,
          country: undefined,
        },
        userCustomization: userCustomization ?? null,
        extraUsageConfig,
        estimatedInputTokens,
        fileTokens: normalizedFileTokens,
        sandboxFiles,
        chatFinishReason: chat?.finish_reason,
        logger: nextJsAxiomLogger,
        chatLogger,
        usageRefundTracker,
        abortController: userStopSignal,
        preemptiveTimeout,
      });

      const stream = createUIMessageStream({ execute });

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
            nextJsAxiomLogger.warn("Stream resumption setup failed", {
              chatId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      });
    } catch (error) {
      // Clear timeout if error occurs before onFinish
      preemptiveTimeout?.clear();

      // Refund credits if any were deducted (idempotent - only refunds once)
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
