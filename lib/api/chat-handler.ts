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
import { stripProviderMetadata } from "@/lib/utils/message-processor";
import { systemPrompt } from "@/lib/system-prompt";
import { createTools } from "@/lib/ai/tools";
import { generateTitleFromUserMessageWithWriter } from "@/lib/actions";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import type {
  ChatMode,
  Todo,
  SandboxPreference,
  ExtraUsageConfig,
} from "@/types";
import { getBaseTodosForRequest } from "@/lib/utils/todo-utils";
import { checkRateLimit, deductAgentUsage } from "@/lib/rate-limit";
import { getExtraUsageBalance } from "@/lib/extra-usage";
import { countMessagesTokens } from "@/lib/token-utils";
import { ChatSDKError } from "@/lib/errors";
import PostHogClient from "@/app/posthog";
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
  saveChatSummary,
} from "@/lib/db/actions";
import {
  createCancellationSubscriber,
  createPreemptiveTimeout,
} from "@/lib/utils/stream-cancellation";
import { v4 as uuidv4 } from "uuid";
import { processChatMessages } from "@/lib/chat/chat-processor";
import { createTrackedProvider } from "@/lib/ai/providers";
import { uploadSandboxFiles } from "@/lib/utils/sandbox-file-utils";
import { after } from "next/server";
import { createResumableStreamContext } from "resumable-stream";
import { checkAndSummarizeIfNeeded } from "@/lib/utils/message-summarization";
import {
  writeUploadStartStatus,
  writeUploadCompleteStatus,
  writeSummarizationStarted,
  writeSummarizationCompleted,
  createSummarizationCompletedPart,
  writeRateLimitWarning,
} from "@/lib/utils/stream-writer-utils";
import { Id } from "@/convex/_generated/dataModel";
import { getMaxStepsForUser } from "@/lib/chat/chat-processor";

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
    let preemptiveTimeout:
      | ReturnType<typeof createPreemptiveTimeout>
      | undefined;

    try {
      const {
        messages,
        mode,
        todos,
        chatId,
        regenerate,
        temporary,
        sandboxPreference,
      }: {
        messages: UIMessage[];
        mode: ChatMode;
        chatId: string;
        todos?: Todo[];
        regenerate?: boolean;
        temporary?: boolean;
        sandboxPreference?: SandboxPreference;
      } = await req.json();

      const { userId, subscription } = await getUserIDAndPro(req);
      const userLocation = geolocation(req);

      if (mode === "agent" && subscription === "free") {
        throw new ChatSDKError(
          "forbidden:chat",
          "Agent mode is only available for Pro users. Please upgrade to access this feature.",
        );
      }

      // Set up pre-emptive abort before Vercel timeout (moved early to cover entire request)
      const userStopSignal = new AbortController();
      preemptiveTimeout = createPreemptiveTimeout({
        chatId,
        mode,
        abortController: userStopSignal,
      });

      const { truncatedMessages, chat, isNewChat } = await getMessagesByChatId({
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

      const { processedMessages, selectedModel, sandboxFiles } =
        await processChatMessages({
          messages: truncatedMessages,
          mode,
          subscription,
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
      const estimatedInputTokens =
        mode === "agent" || subscription !== "free"
          ? countMessagesTokens(truncatedMessages, {})
          : 0;

      // Build extra usage config (paid users only, works for both agent and ask modes)
      // extra_usage_enabled is in userCustomization, balance is in extra_usage
      let extraUsageConfig: ExtraUsageConfig | undefined;
      if (subscription !== "free") {
        const extraUsageEnabled =
          userCustomization?.extra_usage_enabled ?? false;

        if (extraUsageEnabled) {
          const balanceInfo = await getExtraUsageBalance(userId);
          if (balanceInfo && balanceInfo.balanceDollars > 0) {
            extraUsageConfig = {
              enabled: true,
              hasBalance: true,
              balanceDollars: balanceInfo.balanceDollars,
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
        ));

      const posthog = PostHogClient();
      const assistantMessageId = uuidv4();

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

      const stream = createUIMessageStream({
        execute: async ({ writer }) => {
          // Send rate limit warnings based on subscription type
          // Skip warnings if extra usage is enabled with balance (user can continue)
          const hasExtraUsage =
            extraUsageConfig?.enabled && extraUsageConfig?.hasBalance;
          if (subscription === "free") {
            // Free users: sliding window (remaining count)
            if (rateLimitInfo.remaining <= 5) {
              writeRateLimitWarning(writer, {
                warningType: "sliding-window",
                remaining: rateLimitInfo.remaining,
                resetTime: rateLimitInfo.resetTime.toISOString(),
                mode,
                subscription,
              });
            }
          } else if (
            rateLimitInfo.session &&
            rateLimitInfo.weekly &&
            !hasExtraUsage
          ) {
            // Paid users: token bucket (remaining percentage at 10%)
            // Don't show warning if extra usage is enabled - user can continue with balance
            const sessionPercent =
              (rateLimitInfo.session.remaining / rateLimitInfo.session.limit) *
              100;
            const weeklyPercent =
              (rateLimitInfo.weekly.remaining / rateLimitInfo.weekly.limit) *
              100;

            if (sessionPercent <= 10) {
              writeRateLimitWarning(writer, {
                warningType: "token-bucket",
                bucketType: "session",
                remainingPercent: Math.round(sessionPercent),
                resetTime: rateLimitInfo.session.resetTime.toISOString(),
                subscription,
              });
            }

            if (weeklyPercent <= 10) {
              writeRateLimitWarning(writer, {
                warningType: "token-bucket",
                bucketType: "weekly",
                remainingPercent: Math.round(weeklyPercent),
                resetTime: rateLimitInfo.weekly.resetTime.toISOString(),
                subscription,
              });
            }
          }

          const {
            tools,
            getSandbox,
            ensureSandbox,
            getTodoManager,
            getFileAccumulator,
            sandboxManager,
          } = createTools(
            userId,
            writer,
            mode,
            userLocation,
            baseTodos,
            memoryEnabled,
            temporary,
            assistantMessageId,
            sandboxPreference,
            process.env.CONVEX_SERVICE_ROLE_KEY,
            userCustomization?.scope_exclusions,
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
            mode === "agent" &&
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

          if (mode === "agent" && sandboxFiles && sandboxFiles.length > 0) {
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

          const trackedProvider = createTrackedProvider(
            userId,
            chatId,
            subscription,
            posthog,
          );

          let currentSystemPrompt = await systemPrompt(
            userId,
            mode,
            subscription,
            selectedModel,
            userCustomization,
            temporary,
            chat?.finish_reason,
            sandboxContext,
          );

          let streamFinishReason: string | undefined;
          // finalMessages will be set in prepareStep if summarization is needed
          let finalMessages = processedMessages;
          let hasSummarized = false;
          const isReasoningModel = mode === "agent";

          // Track metrics for data collection
          const streamStartTime = Date.now();
          const configuredModelId =
            trackedProvider.languageModel(selectedModel).modelId;
          let streamUsage: Record<string, unknown> | undefined;
          let responseModel: string | undefined;

          const result = streamText({
            model: trackedProvider.languageModel(selectedModel),
            system: currentSystemPrompt,
            messages: await convertToModelMessages(finalMessages),
            tools,
            // Refresh system prompt when memory updates occur, cache and reuse until next update
            prepareStep: async ({ steps, messages }) => {
              try {
                // Run summarization check on every step (non-temporary chats only)
                // but only summarize once
                if (!temporary && !hasSummarized) {
                  const {
                    needsSummarization,
                    summarizedMessages,
                    cutoffMessageId,
                    summaryText,
                  } = await checkAndSummarizeIfNeeded(
                    messages,
                    finalMessages,
                    subscription,
                    trackedProvider.languageModel("summarization-model"),
                    mode,
                  );

                  if (needsSummarization && cutoffMessageId && summaryText) {
                    writeSummarizationStarted(writer);

                    // Save the summary metadata to the chat document FIRST
                    await saveChatSummary({
                      chatId,
                      summaryText,
                      summaryUpToMessageId: cutoffMessageId,
                    });

                    // Only update state after successful save
                    finalMessages = summarizedMessages;
                    hasSummarized = true;

                    writeSummarizationCompleted(writer);
                    // Push only the completed event to parts array for persistence
                    summarizationParts.push(createSummarizationCompletedPart());
                    // Return updated messages for this step
                    return {
                      messages: await convertToModelMessages(finalMessages),
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

                if (!wasMemoryUpdate) {
                  return {
                    messages,
                    ...(currentSystemPrompt && { system: currentSystemPrompt }),
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
                  chat?.finish_reason,
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
            providerOptions: {
              xai: {
                // Disable storing the conversation in XAI's database
                store: false,
              },
              openrouter: {
                ...(isReasoningModel
                  ? { reasoning: { enabled: true } }
                  : { reasoning: { enabled: false } }),
                provider: {
                  ...(subscription === "free"
                    ? {
                        sort: "price",
                      }
                    : { sort: "latency" }),
                },
              },
            },
            experimental_transform: smoothStream({ chunking: "word" }),
            stopWhen: stepCountIs(getMaxStepsForUser(mode, subscription)),
            onChunk: async (chunk) => {
              // Track all tool calls immediately (no throttle)
              if (chunk.chunk.type === "tool-call" && posthog) {
                // Tools that interact with the sandbox environment
                const sandboxEnvironmentTools = [
                  "run_terminal_cmd",
                  "get_terminal_files",
                  "read_file",
                  "write_file",
                  "search_replace",
                ];

                // Determine sandbox type for environment-interacting tools
                const sandboxType = sandboxEnvironmentTools.includes(
                  chunk.chunk.toolName,
                )
                  ? sandboxPreference && sandboxPreference !== "e2b"
                    ? "local"
                    : "e2b"
                  : undefined;

                posthog.capture({
                  distinctId: userId,
                  event: "hackerai-" + chunk.chunk.toolName,
                  properties: {
                    ...(sandboxType && { sandboxType }),
                  },
                });
              }
            },
            onFinish: async ({ finishReason, usage, response }) => {
              // If preemptive timeout triggered, use "timeout" as finish reason
              if (preemptiveTimeout?.isPreemptive()) {
                streamFinishReason = "timeout";
              } else {
                streamFinishReason = finishReason;
              }
              // Capture full usage and model
              streamUsage = usage as Record<string, unknown>;
              responseModel = response?.modelId;

              // Deduct additional cost (output + any input difference)
              // Input cost was already deducted upfront in checkRateLimit
              // Free users don't have token buckets, so skip for them
              if (subscription !== "free" && usage) {
                await deductAgentUsage(
                  userId,
                  subscription,
                  estimatedInputTokens,
                  usage.inputTokens || 0,
                  usage.outputTokens || 0,
                  extraUsageConfig,
                );
              }
            },
            onError: async (error) => {
              console.error("Error:", error);
            },
          });

          writer.merge(
            result.toUIMessageStream({
              generateMessageId: () => assistantMessageId,
              onFinish: async ({ messages, isAborted }) => {
                // Clear pre-emptive timeout
                preemptiveTimeout?.clear();

                // Stop cancellation subscriber
                await cancellationSubscriber.stop();
                subscriberStopped = true;

                // Clear finish reason for user-initiated aborts (not pre-emptive timeouts)
                // This prevents showing "going off course" message when user clicks stop
                if (isAborted && !preemptiveTimeout?.isPreemptive()) {
                  streamFinishReason = undefined;
                }

                // Sandbox cleanup is automatic with auto-pause
                // The sandbox will auto-pause after inactivity timeout (7 minutes)
                // No manual pause needed

                // Always wait for title generation to complete
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
                        streamFinishReason ||
                        mergedTodos.length > 0,
                      );

                  if (shouldPersist) {
                    // updateChat automatically clears stream state (active_stream_id and canceled_at)
                    await updateChat({
                      chatId,
                      title: generatedTitle,
                      finishReason: streamFinishReason,
                      todos: mergedTodos,
                      defaultModelSlug: mode,
                    });
                  } else {
                    // If not persisting, still need to clear stream state
                    await prepareForNewStream({ chatId });
                  }

                  const accumulatedFiles = getFileAccumulator().getAll();
                  const newFileIds = accumulatedFiles.map((f) => f.fileId);

                  // If user aborted (not pre-emptive) and no files to add, skip message save (frontend already saved)
                  // Pre-emptive aborts should always save to ensure data persistence before timeout
                  if (
                    isAborted &&
                    !preemptiveTimeout?.isPreemptive() &&
                    newFileIds.length === 0
                  ) {
                    return;
                  }

                  // Save messages (either full save or just append extraFileIds)
                  for (const message of messages) {
                    // For assistant messages, prepend summarization parts if any
                    const messageWithSummarization =
                      message.role === "assistant" &&
                      summarizationParts.length > 0
                        ? {
                            ...message,
                            parts: [...summarizationParts, ...message.parts],
                          }
                        : message;

                    // Strip providerMetadata from parts before saving
                    const messageToSave = stripProviderMetadata(
                      messageWithSummarization,
                    );

                    // Skip saving messages with no parts or files
                    // This prevents saving empty messages on error that would accumulate on retry
                    if (
                      (!messageToSave.parts ||
                        messageToSave.parts.length === 0) &&
                      newFileIds.length === 0
                    ) {
                      continue;
                    }

                    await saveMessage({
                      chatId,
                      userId,
                      message: messageToSave,
                      // Only include metrics for assistant messages
                      extraFileIds: newFileIds,
                      model: responseModel || configuredModelId,
                      generationTimeMs: Date.now() - streamStartTime,
                      finishReason: streamFinishReason,
                      usage: streamUsage,
                    });
                  }

                  // Send file metadata via stream for resumable stream clients
                  // Uses accumulated metadata directly - no DB query needed!
                  sendFileMetadataToStream(accumulatedFiles);
                } else {
                  // For temporary chats, send file metadata via stream before cleanup
                  const tempFiles = getFileAccumulator().getAll();
                  sendFileMetadataToStream(tempFiles);

                  // Ensure temp stream row is removed backend-side
                  await deleteTempStreamForBackend({ chatId });
                }
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

      // Handle ChatSDKErrors (including authentication errors)
      if (error instanceof ChatSDKError) {
        return error.toResponse();
      }

      // Handle unexpected errors
      console.error("Unexpected error in chat route:", error);
      const unexpectedError = new ChatSDKError(
        "offline:chat",
        error instanceof Error ? error.message : "Unknown error occurred",
      );
      return unexpectedError.toResponse();
    }
  };
};
