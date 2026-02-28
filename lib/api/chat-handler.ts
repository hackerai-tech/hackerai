import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateId,
  stepCountIs,
  streamText,
  UIMessage,
  UIMessagePart,
  smoothStream,
} from "ai";
import { systemPrompt, getResumeSection } from "@/lib/system-prompt";
import {
  tokenExhaustedAfterSummarization,
  TOKEN_EXHAUSTION_FINISH_REASON,
} from "@/lib/chat/stop-conditions";
import { createTools } from "@/lib/ai/tools";
import { generateTitleFromUserMessageWithWriter } from "@/lib/actions";
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
import {
  checkRateLimit,
  deductUsage,
  UsageRefundTracker,
} from "@/lib/rate-limit";
import { getExtraUsageBalance } from "@/lib/extra-usage";
import {
  countMessagesTokens,
  getMaxTokensForSubscription,
} from "@/lib/token-utils";
import { countTokens } from "gpt-tokenizer";
import { ChatSDKError } from "@/lib/errors";
import PostHogClient from "@/app/posthog";
import { createChatLogger, type ChatLogger } from "@/lib/api/chat-logger";
import {
  hasFileAttachments,
  countFileAttachments,
  sendRateLimitWarnings,
  buildProviderOptions,
  isXaiSafetyError,
  isProviderApiError,
  computeContextUsage,
  writeContextUsage,
  contextUsageEnabled,
  runSummarizationStep,
  appendSystemReminderToLastUserMessage,
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
import { createTrackedProvider } from "@/lib/ai/providers";
import {
  uploadSandboxFiles,
  getUploadBasePath,
} from "@/lib/utils/sandbox-file-utils";
import { after } from "next/server";
import { createResumableStreamContext } from "resumable-stream";
import {
  writeUploadStartStatus,
  writeUploadCompleteStatus,
  createSummarizationCompletedPart,
} from "@/lib/utils/stream-writer-utils";
import { Id } from "@/convex/_generated/dataModel";
import { getMaxStepsForUser } from "@/lib/chat/chat-processor";
import { nextJsAxiomLogger } from "@/lib/axiom/server";
import { extractErrorDetails } from "@/lib/utils/error-utils";
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
      }: {
        messages: UIMessage[];
        mode: ChatMode;
        chatId: string;
        todos?: Todo[];
        regenerate?: boolean;
        temporary?: boolean;
        sandboxPreference?: SandboxPreference;
        selectedModel?: string;
      } = await req.json();

      const selectedModelOverride: SelectedModel | undefined =
        rawSelectedModel && isSelectedModel(rawSelectedModel)
          ? rawSelectedModel
          : undefined;

      // Agent-long must use /api/agent-long (Trigger.dev), not this handler
      if (mode === "agent-long") {
        throw new ChatSDKError(
          "bad_request:api",
          "Agent-long mode must use POST /api/agent-long",
        );
      }

      // Initialize chat logger
      chatLogger = createChatLogger({ chatId, endpoint });
      chatLogger.setRequestDetails({
        mode,
        isTemporary: !!temporary,
        isRegenerate: !!regenerate,
      });

      const { userId, subscription } = await getUserIDAndPro(req);
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
      const memoryEnabled = userCustomization?.include_memory_entries ?? true;

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
          hasSandboxFiles: !!(sandboxFiles && sandboxFiles.length > 0),
          hasFileAttachments: hasFileAttachments(truncatedMessages),
          fileCount: fileCounts.totalFiles,
          fileImageCount: fileCounts.imageCount,
          sandboxPreference,
          memoryEnabled,
          isNewChat,
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
          // Set extraUsageConfig if user has balance OR auto-reload is enabled
          // (auto-reload can add funds even when balance is $0)
          if (
            balanceInfo &&
            (balanceInfo.balanceDollars > 0 || balanceInfo.autoReloadEnabled)
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
        ));

      // Track deductions for potential refund on error
      usageRefundTracker.recordDeductions(rateLimitInfo);

      // Add rate limit and extra usage context to logger
      chatLogger.setRateLimit(
        {
          pointsDeducted: rateLimitInfo.pointsDeducted,
          extraUsagePointsDeducted: rateLimitInfo.extraUsagePointsDeducted,
          session: rateLimitInfo.session,
          weekly: rateLimitInfo.weekly,
          remaining: rateLimitInfo.remaining,
          subscription,
        },
        extraUsageConfig,
      );

      const posthog = PostHogClient();
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

      // Track summarization events to add to message parts
      const summarizationParts: UIMessagePart<any, any>[] = [];

      // Start stream timing
      chatLogger.startStream();

      const stream = createUIMessageStream({
        execute: async ({ writer }) => {
          // Send rate limit warnings based on subscription type
          sendRateLimitWarnings(writer, { subscription, mode, rateLimitInfo });

          const {
            tools,
            getSandbox,
            ensureSandbox,
            getTodoManager,
            getFileAccumulator,
            sandboxManager,
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
              console.warn("Failed to get sandbox context for prompt:", error);
            }
          }

          if (isAgentMode(mode) && sandboxFiles && sandboxFiles.length > 0) {
            writeUploadStartStatus(writer);
            try {
              await uploadSandboxFiles(sandboxFiles, ensureSandbox);
            } finally {
              writeUploadCompleteStatus(writer);
            }
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

          // Compute and stream actual context usage breakdown (when enabled)
          const ctxSystemTokens = contextUsageEnabled ? systemPromptTokens : 0;
          const ctxMaxTokens = contextUsageEnabled
            ? getMaxTokensForSubscription(subscription)
            : 0;
          let ctxUsage = contextUsageEnabled
            ? computeContextUsage(
                truncatedMessages,
                fileTokens,
                ctxSystemTokens,
                ctxMaxTokens,
              )
            : {
                systemTokens: 0,
                summaryTokens: 0,
                messagesTokens: 0,
                maxTokens: 0,
              };
          if (contextUsageEnabled) {
            writeContextUsage(writer, ctxUsage);
          }

          let streamFinishReason: string | undefined;
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

          let hasSummarized = false;
          let stoppedDueToTokenExhaustion = false;
          let lastStepInputTokens = 0;
          const isReasoningModel = isAgentMode(mode);

          // Track metrics for data collection
          const streamStartTime = Date.now();
          const configuredModelId =
            trackedProvider.languageModel(selectedModel).modelId;

          let streamUsage: Record<string, unknown> | undefined;
          let responseModel: string | undefined;
          let isRetryWithFallback = false;
          const fallbackModel =
            mode === "agent" ? "fallback-agent-model" : "fallback-ask-model";

          // Accumulated usage across all steps for deduction
          let accumulatedInputTokens = 0;
          let accumulatedOutputTokens = 0;
          let accumulatedProviderCost = 0;
          let hasDeductedUsage = false;

          // Helper to deduct accumulated usage (called from multiple exit points)
          const deductAccumulatedUsage = async () => {
            if (hasDeductedUsage || subscription === "free") return;
            if (accumulatedInputTokens > 0 || accumulatedOutputTokens > 0) {
              hasDeductedUsage = true;
              await deductUsage(
                userId,
                subscription,
                estimatedInputTokens,
                accumulatedInputTokens,
                accumulatedOutputTokens,
                extraUsageConfig,
                accumulatedProviderCost > 0
                  ? accumulatedProviderCost
                  : undefined,
                selectedModel,
              );
            }
          };

          // Helper to create streamText with a given model (reused for retry)
          const createStream = async (modelName: string) =>
            streamText({
              model: trackedProvider.languageModel(modelName),
              system: currentSystemPrompt,
              messages: await convertToModelMessages(finalMessages),
              tools,
              // Refresh system prompt when memory updates occur, cache and reuse until next update
              prepareStep: async ({ steps, messages }) => {
                try {
                  // Run summarization check on every step (non-temporary chats only)
                  // but only summarize once
                  if (!temporary && !hasSummarized) {
                    const result = await runSummarizationStep({
                      messages: finalMessages,
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
                    });

                    if (
                      result.needsSummarization &&
                      result.summarizedMessages
                    ) {
                      hasSummarized = true;
                      summarizationParts.push(
                        createSummarizationCompletedPart(),
                      );
                      if (result.contextUsage) {
                        ctxUsage = result.contextUsage;
                      }
                      return {
                        messages: await convertToModelMessages(
                          result.summarizedMessages,
                        ),
                      };
                    }
                  }

                  const lastStep = Array.isArray(steps)
                    ? steps.at(-1)
                    : undefined;
                  const toolResults =
                    (lastStep && (lastStep as any).toolResults) || [];
                  const wasMemoryUpdate =
                    Array.isArray(toolResults) &&
                    toolResults.some((r) => r?.toolName === "update_memory");

                  // Check if any note was created, updated, or deleted (need to refresh notes in system prompt)
                  const wasNoteModified =
                    Array.isArray(toolResults) &&
                    toolResults.some(
                      (r) =>
                        r?.toolName === "create_note" ||
                        r?.toolName === "update_note" ||
                        r?.toolName === "delete_note",
                    );

                  if (!wasMemoryUpdate && !wasNoteModified) {
                    return {
                      messages,
                      ...(currentSystemPrompt && {
                        system: currentSystemPrompt,
                      }),
                    };
                  }

                  // Refresh and cache the updated system prompt
                  currentSystemPrompt = await systemPrompt(
                    userId,
                    mode,
                    subscription,
                    selectedModel,
                    userCustomization,
                    temporary,
                    sandboxContext,
                  );

                  return {
                    messages,
                    system: currentSystemPrompt,
                  };
                } catch (error) {
                  console.error("Error in prepareStep:", error);
                  return currentSystemPrompt
                    ? { system: currentSystemPrompt }
                    : {};
                }
              },
              abortSignal: userStopSignal.signal,
              providerOptions: buildProviderOptions(
                isReasoningModel,
                subscription,
              ),
              experimental_transform: smoothStream({ chunking: "word" }),
              stopWhen: isAgentMode(mode)
                ? [
                    stepCountIs(getMaxStepsForUser(mode, subscription)),
                    tokenExhaustedAfterSummarization({
                      getLastStepInputTokens: () => lastStepInputTokens,
                      getHasSummarized: () => hasSummarized,
                      onFired: () => {
                        stoppedDueToTokenExhaustion = true;
                      },
                    }),
                  ]
                : stepCountIs(getMaxStepsForUser(mode, subscription)),
              onChunk: async (chunk) => {
                if (chunk.chunk.type === "tool-call") {
                  const sandboxType = sandboxManager.getSandboxType(
                    chunk.chunk.toolName,
                  );

                  chatLogger!.recordToolCall(chunk.chunk.toolName, sandboxType);

                  if (posthog) {
                    posthog.capture({
                      distinctId: userId,
                      event: "hackerai-" + chunk.chunk.toolName,
                      properties: {
                        mode,
                        ...(sandboxType && { sandboxType }),
                      },
                    });
                  }
                }
              },
              onStepFinish: async ({ usage }) => {
                // Accumulate usage from each step (deduction happens in UI stream's onFinish)
                if (usage) {
                  accumulatedInputTokens += usage.inputTokens || 0;
                  accumulatedOutputTokens += usage.outputTokens || 0;
                  lastStepInputTokens = usage.inputTokens || 0;
                  // Provider cost when available; deductUsage falls back to token-based calculation
                  const stepCost = (usage as { raw?: { cost?: number } }).raw
                    ?.cost;
                  if (stepCost) {
                    accumulatedProviderCost += stepCost;
                  }
                }
              },
              onFinish: async ({ finishReason, usage, response }) => {
                // If preemptive timeout triggered, use "timeout" as finish reason
                if (preemptiveTimeout?.isPreemptive()) {
                  streamFinishReason = "timeout";
                } else if (stoppedDueToTokenExhaustion) {
                  streamFinishReason = TOKEN_EXHAUSTION_FINISH_REASON;
                } else {
                  streamFinishReason = finishReason;
                }
                // Capture full usage and model
                streamUsage = usage as Record<string, unknown>;
                responseModel = response?.modelId;

                // Update logger with model and usage
                chatLogger!.setStreamResponse(responseModel, streamUsage);
              },
              onError: async (error) => {
                // Suppress xAI safety check errors from logging (they're expected for certain content)
                if (!isXaiSafetyError(error)) {
                  console.error("Error:", error);

                  // Log provider errors to Axiom with request context
                  nextJsAxiomLogger.error("Provider streaming error", {
                    chatId,
                    endpoint,
                    mode,
                    model: selectedModel,
                    userId,
                    subscription,
                    isTemporary: temporary,
                    ...extractErrorDetails(error),
                  });
                }
                // Refund credits on streaming errors (idempotent - only refunds once)
                await usageRefundTracker.refund();
              },
            });

          let result;
          try {
            result = await createStream(selectedModel);
          } catch (error) {
            // If provider returns error (e.g., INVALID_ARGUMENT from Gemini), retry with fallback
            if (isProviderApiError(error) && !isRetryWithFallback) {
              nextJsAxiomLogger.error(
                "Provider API error, retrying with fallback",
                {
                  chatId,
                  endpoint,
                  mode,
                  originalModel: selectedModel,
                  fallbackModel,
                  userId,
                  subscription,
                  isTemporary: temporary,
                  ...extractErrorDetails(error),
                },
              );

              isRetryWithFallback = true;
              lastStepInputTokens = 0;
              stoppedDueToTokenExhaustion = false;
              result = await createStream(fallbackModel);
            } else {
              throw error;
            }
          }

          writer.merge(
            result.toUIMessageStream({
              generateMessageId: () => assistantMessageId,
              onFinish: async ({ messages, isAborted }) => {
                // Check if stream finished with only step-start (indicates incomplete response)
                const lastAssistantMessage = messages
                  .slice()
                  .reverse()
                  .find((m) => m.role === "assistant");
                const hasOnlyStepStart =
                  lastAssistantMessage?.parts?.length === 1 &&
                  lastAssistantMessage.parts[0]?.type === "step-start";

                if (hasOnlyStepStart) {
                  nextJsAxiomLogger.error(
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

                  // Retry with fallback model if not already retrying
                  if (!isRetryWithFallback && !isAborted) {
                    isRetryWithFallback = true;
                    lastStepInputTokens = 0;
                    stoppedDueToTokenExhaustion = false;
                    const fallbackStartTime = Date.now();

                    const retryResult = await createStream(fallbackModel);
                    const retryMessageId = generateId();

                    writer.merge(
                      retryResult.toUIMessageStream({
                        generateMessageId: () => retryMessageId,
                        onFinish: async ({
                          messages: retryMessages,
                          isAborted: retryAborted,
                        }) => {
                          // Cleanup for retry
                          preemptiveTimeout?.clear();
                          if (!subscriberStopped) {
                            await cancellationSubscriber.stop();
                            subscriberStopped = true;
                          }

                          chatLogger!.setSandbox(
                            sandboxManager.getSandboxInfo(),
                          );
                          chatLogger!.emitSuccess({
                            finishReason: streamFinishReason,
                            wasAborted: retryAborted,
                            wasPreemptiveTimeout: false,
                            hadSummarization: hasSummarized,
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
                                summarizationParts.length > 0
                                  ? {
                                      ...msg,
                                      parts: [
                                        ...summarizationParts,
                                        ...(msg.parts || []),
                                      ],
                                    }
                                  : msg;

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

                            // Send file metadata via stream for resumable stream clients
                            sendFileMetadataToStream(accumulatedFiles);
                          } else {
                            // For temporary chats, send file metadata via stream before cleanup
                            const tempFiles = getFileAccumulator().getAll();
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
                                p.type === "tool-invocation" ||
                                p.type === "reasoning",
                            ) ?? false;
                          const fallbackPartTypes =
                            fallbackAssistantMessage?.parts?.map(
                              (p) => p.type,
                            ) ?? [];

                          nextJsAxiomLogger.info("Fallback completed", {
                            chatId,
                            originalModel: selectedModel,
                            originalAssistantMessageId: assistantMessageId,
                            fallbackModel,
                            fallbackAssistantMessageId: retryMessageId,
                            fallbackDurationMs: Date.now() - fallbackStartTime,
                            fallbackSuccess: fallbackHasContent,
                            fallbackWasAborted: retryAborted,
                            fallbackMessageCount: retryMessages.length,
                            fallbackPartTypes,
                            userId,
                            subscription,
                          });

                          // Deduct accumulated usage (includes both original + retry streams)
                          await deductAccumulatedUsage();
                        },
                        sendReasoning: true,
                      }),
                    );

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
                    nextJsAxiomLogger.info("Preemptive timeout cleanup step", {
                      chatId,
                      step,
                      stepDurationMs: stepDuration,
                      totalElapsedSinceTriggerMs: totalElapsed,
                      endpoint,
                    });
                  }
                };

                if (isPreemptiveAbort) {
                  nextJsAxiomLogger.info(
                    "Preemptive timeout onFinish started",
                    {
                      chatId,
                      endpoint,
                      timeSinceTriggerMs: triggerTime
                        ? onFinishStartTime - triggerTime
                        : null,
                      messageCount: messages.length,
                      isTemporary: temporary,
                    },
                  );
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
                  streamFinishReason = undefined;
                }

                // Emit wide event
                stepStart = Date.now();
                chatLogger!.setSandbox(sandboxManager.getSandboxInfo());
                chatLogger!.emitSuccess({
                  finishReason: streamFinishReason,
                  wasAborted: isAborted,
                  wasPreemptiveTimeout: isPreemptiveAbort,
                  hadSummarization: hasSummarized,
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
                        streamFinishReason ||
                        mergedTodos.length > 0,
                      );

                  if (shouldPersist) {
                    // updateChat automatically clears stream state (active_stream_id and canceled_at)
                    stepStart = Date.now();
                    await updateChat({
                      chatId,
                      title: generatedTitle,
                      finishReason: streamFinishReason,
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

                  // On abort, streamText.onFinish may not have fired yet, so streamUsage
                  // could be undefined. Await usage from result to ensure we capture it.
                  // This must happen BEFORE we decide whether to skip saving.
                  let resolvedUsage: Record<string, unknown> | undefined =
                    streamUsage;
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

                  // If user aborted (not pre-emptive), skip message save when:
                  // 1. skipSave signal received via Redis (edit/regenerate/retry — message will be discarded)
                  // 2. No files, tools, or usage to record (frontend already saved the message)
                  if (
                    isAborted &&
                    !isPreemptiveAbort &&
                    (cancellationSubscriber.shouldSkipSave() ||
                      (newFileIds.length === 0 &&
                        !hasIncompleteToolCalls &&
                        !hasUsageToRecord))
                  ) {
                    await deductAccumulatedUsage();
                    return;
                  }

                  // Save messages (either full save or just append extraFileIds)
                  stepStart = Date.now();
                  for (const message of messages) {
                    // For assistant messages, prepend summarization parts if any
                    let processedMessage =
                      message.role === "assistant" &&
                      summarizationParts.length > 0
                        ? {
                            ...message,
                            parts: [...summarizationParts, ...message.parts],
                          }
                        : message;

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
                    // Falls back to streamUsage for non-abort cases
                    // On user-initiated abort, use updateOnly as safety net:
                    // only patch existing messages (add files/usage), don't create new ones.
                    // This prevents orphan messages when Redis skipSave signal was missed.
                    await saveMessage({
                      chatId,
                      userId,
                      message: processedMessage,
                      extraFileIds: newFileIds,
                      model: responseModel || configuredModelId,
                      generationTimeMs: Date.now() - streamStartTime,
                      finishReason: streamFinishReason,
                      usage: resolvedUsage ?? streamUsage,
                      updateOnly:
                        isAborted && !isPreemptiveAbort ? true : undefined,
                    });
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
                  nextJsAxiomLogger.info(
                    "Preemptive timeout onFinish completed",
                    {
                      chatId,
                      endpoint,
                      totalOnFinishDurationMs: totalDuration,
                      totalSinceTriggerMs: triggerTime
                        ? Date.now() - triggerTime
                        : null,
                    },
                  );
                  await nextJsAxiomLogger.flush();
                }

                // Send updated context usage with output tokens included
                if (contextUsageEnabled) {
                  writeContextUsage(writer, {
                    ...ctxUsage,
                    messagesTokens:
                      ctxUsage.messagesTokens + accumulatedOutputTokens,
                  });
                }

                // Deduct accumulated usage if not already done
                await deductAccumulatedUsage();
              },
              sendReasoning: true,
            }),
          );
        },
      });

      return createUIMessageStreamResponse({
        stream,
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
          } catch (_) {
            // ignore redis errors
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

      // Handle unexpected errors
      chatLogger?.emitUnexpectedError(error);

      const unexpectedError = new ChatSDKError(
        "offline:chat",
        error instanceof Error ? error.message : "Unknown error occurred",
      );
      return unexpectedError.toResponse();
    }
  };
};
