import {
  convertToModelMessages,
  createUIMessageStream,
  stepCountIs,
  streamText,
  UIMessage,
  UIMessagePart,
  smoothStream,
  JsonToSseTransformStream,
} from "ai";
import { stripProviderMetadata } from "@/lib/utils/message-processor";
import { systemPrompt } from "@/lib/system-prompt";
import { createTools } from "@/lib/ai/tools";
import { stripMarkersFromMessages } from "@/lib/utils/prompt-injection-protection";
import { generateTitleFromUserMessageWithWriter } from "@/lib/actions";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import type { ChatMode, Todo, SandboxPreference } from "@/types";
import { getBaseTodosForRequest } from "@/lib/utils/todo-utils";
import { checkRateLimit } from "@/lib/rate-limit";
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
  createCancellationPoller,
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
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import { getMaxStepsForUser } from "@/lib/chat/chat-processor";

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

let globalStreamContext: any | null = null;

export const getStreamContext = () => {
  if (!globalStreamContext) {
    try {
      globalStreamContext = createResumableStreamContext({ waitUntil: after });
    } catch (error: any) {
      if (
        typeof error?.message === "string" &&
        error.message.includes("REDIS_URL")
      ) {
        console.log(
          " > Resumable streams are disabled due to missing REDIS_URL",
        );
      } else {
        console.warn("Resumable stream context init failed:", error);
      }
    }
  }
  return globalStreamContext;
};

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

      const rateLimitInfo = await checkRateLimit(userId, mode, subscription);

      const { processedMessages, selectedModel, sandboxFiles } =
        await processChatMessages({
          messages: truncatedMessages,
          mode,
          subscription,
        });

      const userCustomization = await getUserCustomization({ userId });
      const memoryEnabled = userCustomization?.include_memory_entries ?? true;
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

      // Start cancellation poller (works for both regular and temporary chats)
      let pollerStopped = false;
      const cancellationPoller = createCancellationPoller({
        chatId,
        isTemporary: !!temporary,
        abortController: userStopSignal,
        onStop: () => {
          pollerStopped = true;
        },
      });

      // Track summarization events to add to message parts
      const summarizationParts: UIMessagePart<any, any>[] = [];

      const stream = createUIMessageStream({
        execute: async ({ writer }) => {
          // Send rate limit warning if at or below threshold
          const isPaidUser = subscription !== "free";
          const warningThreshold = isPaidUser ? 10 : 5;

          if (rateLimitInfo.remaining <= warningThreshold) {
            writeRateLimitWarning(writer, {
              remaining: rateLimitInfo.remaining,
              resetTime: rateLimitInfo.resetTime.toISOString(),
              mode,
              subscription,
            });
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
            // Also strip external data markers from old tool outputs to save tokens
            prepareStep: async ({ steps, messages }) => {
              try {
                // Strip external data markers from tool results to save tokens
                // These markers protect against prompt injection but aren't needed
                // for older messages already in the conversation
                const strippedMessages = stripMarkersFromMessages(messages);

                // Run summarization check on every step (non-temporary chats only)
                // but only summarize once
                if (!temporary && !hasSummarized) {
                  const {
                    needsSummarization,
                    summarizedMessages,
                    cutoffMessageId,
                    summaryText,
                  } = await checkAndSummarizeIfNeeded(
                    strippedMessages,
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
                    // Return updated messages for this step (with markers stripped)
                    return {
                      messages: stripMarkersFromMessages(
                        await convertToModelMessages(finalMessages),
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

                // Always return stripped messages to save tokens on each step
                if (!wasMemoryUpdate) {
                  return {
                    messages: strippedMessages,
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
                  messages: strippedMessages,
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
            experimental_transform: isReasoningModel
              ? undefined
              : smoothStream({ chunking: "word" }),
            stopWhen: stepCountIs(getMaxStepsForUser(mode, subscription)),
            onChunk: async (chunk) => {
              // Track all tool calls immediately (no throttle)
              if (chunk.chunk.type === "tool-call") {
                const command =
                  chunk.chunk.toolName === "web"
                    ? (chunk.chunk.input as any)?.command
                    : undefined;
                if (posthog) {
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
                    event: "hackerai-" + (command || chunk.chunk.toolName),
                    properties: {
                      ...(sandboxType && { sandboxType }),
                    },
                  });
                }
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

                // Stop cancellation poller
                cancellationPoller.stop();
                pollerStopped = true;

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

                  const newFileIds = getFileAccumulator().getAll();

                  // If user aborted (not pre-emptive) and no files to add, skip message save (frontend already saved)
                  // Pre-emptive aborts should always save to ensure data persistence before timeout
                  if (
                    isAborted &&
                    !preemptiveTimeout?.isPreemptive() &&
                    (!newFileIds || newFileIds.length === 0)
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
                      (!newFileIds || newFileIds.length === 0)
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
                } else {
                  // For temporary chats, send file metadata via stream before cleanup
                  const newFileIds = getFileAccumulator().getAll();

                  if (newFileIds && newFileIds.length > 0) {
                    try {
                      // Fetch file metadata in batch
                      const fileMetadata = await convex.query(
                        api.fileStorage.getFileMetadataByFileIds,
                        {
                          serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
                          fileIds: newFileIds,
                        },
                      );

                      // Filter out null entries and send via custom stream event
                      const validFileMetadata = fileMetadata.filter(
                        (f): f is NonNullable<typeof f> => f !== null,
                      );

                      if (validFileMetadata.length > 0) {
                        writer.write({
                          type: "data-file-metadata",
                          data: {
                            messageId: assistantMessageId,
                            fileDetails: validFileMetadata,
                          },
                        });
                      }
                    } catch (error) {
                      console.error(
                        "Failed to fetch file metadata for temporary chat:",
                        error,
                      );
                    }
                  }

                  // Ensure temp stream row is removed backend-side
                  await deleteTempStreamForBackend({ chatId });
                }
              },
              sendReasoning: true,
            }),
          );
        },
      });

      // Wrap the UI message stream as SSE
      const sse = stream.pipeThrough(new JsonToSseTransformStream());

      // Create a resumable stream and persist the active stream id (non-temporary chats)
      if (!temporary) {
        const streamContext = getStreamContext();
        if (streamContext) {
          const streamId = uuidv4();
          await startStream({ chatId, streamId });
          const body = await streamContext.resumableStream(streamId, () => sse);
          return new Response(body);
        }
      }

      // Temporary chats do not support resumption; return SSE directly
      return new Response(sse);
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
