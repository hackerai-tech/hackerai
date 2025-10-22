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
import { systemPrompt } from "@/lib/system-prompt";
import { createTools } from "@/lib/ai/tools";
import { pauseSandbox } from "@/lib/ai/tools/utils/sandbox";
import { generateTitleFromUserMessageWithWriter } from "@/lib/actions";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import type { ChatMode, Todo } from "@/types";
import { getBaseTodosForRequest } from "@/lib/utils/todo-utils";
import { checkRateLimit } from "@/lib/rate-limit";
import { ChatSDKError } from "@/lib/errors";
import PostHogClient from "@/app/posthog";
import { geolocation } from "@vercel/functions";
import { getAIHeaders } from "@/lib/actions";
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
      }: {
        messages: UIMessage[];
        mode: ChatMode;
        chatId: string;
        todos?: Todo[];
        regenerate?: boolean;
        temporary?: boolean;
      } = await req.json();

      const { userId, subscription } = await getUserIDAndPro(req);
      const userLocation = geolocation(req);

      if (mode === "agent" && subscription === "free") {
        throw new ChatSDKError(
          "forbidden:chat",
          "Agent mode is only available for Pro users. Please upgrade to access this feature.",
        );
      }

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

      await checkRateLimit(userId, mode, subscription);

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

      const userStopSignal = new AbortController();

      // Set up pre-emptive abort before Vercel timeout
      preemptiveTimeout = createPreemptiveTimeout({
        chatId,
        mode,
        abortController: userStopSignal,
      });

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
          const {
            tools,
            getSandbox,
            ensureSandbox,
            getTodoManager,
            getFileAccumulator,
          } = createTools(
            userId,
            writer,
            mode,
            userLocation,
            baseTodos,
            memoryEnabled,
            temporary,
            assistantMessageId,
            subscription,
          );

          if (mode === "agent" && sandboxFiles && sandboxFiles.length > 0) {
            // Send upload start notification
            writer.write({
              type: "data-upload-status",
              data: {
                message: "Uploading attachments to the computer",
                isUploading: true,
              },
              transient: true,
            });

            try {
              await uploadSandboxFiles(sandboxFiles, ensureSandbox);
            } finally {
              // Send upload complete notification
              writer.write({
                type: "data-upload-status",
                data: {
                  message: "",
                  isUploading: false,
                },
                transient: true,
              });
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
          );

          let currentSystemPrompt = await systemPrompt(
            userId,
            mode,
            subscription,
            userCustomization,
            temporary,
            chat?.finish_reason,
          );

          let streamFinishReason: string | undefined;
          // finalMessages will be set in prepareStep if summarization is needed
          let finalMessages = processedMessages;
          let hasSummarized = false;

          const result = streamText({
            model: trackedProvider.languageModel(selectedModel),
            system: currentSystemPrompt,
            messages: convertToModelMessages(finalMessages),
            tools,
            // Refresh system prompt when memory updates occur, cache and reuse until next update
            prepareStep: async ({ steps, messages }) => {
              try {
                // Run summarization check on every step (agent mode, non-temporary)
                // but only summarize once
                if (mode === "agent" && !temporary && !hasSummarized) {
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
                  );

                  if (needsSummarization && cutoffMessageId && summaryText) {
                    // Send summarization started notification (with ID for reconciliation)
                    const startedEvent = {
                      type: "data-summarization" as const,
                      id: "summarization-status",
                      data: {
                        status: "started",
                        message: "Summarizing chat context",
                      },
                    };
                    writer.write(startedEvent);

                    finalMessages = summarizedMessages;
                    hasSummarized = true;

                    // Save the summary metadata to the chat document
                    await saveChatSummary({
                      chatId,
                      summaryText,
                      summaryUpToMessageId: cutoffMessageId,
                    });

                    // Send summarization completed notification (same ID = replaces started)
                    const completedEvent = {
                      type: "data-summarization" as const,
                      id: "summarization-status",
                      data: {
                        status: "completed",
                        message: "Chat context summarized",
                      },
                    };
                    writer.write(completedEvent);
                    // Push only the completed event to parts array for persistence
                    summarizationParts.push({
                      type: "data-summarization" as const,
                      id: "summarization-status",
                      data: {
                        status: "completed",
                        message: "Chat context summarized",
                      },
                    });
                    // Return updated messages for this step
                    return {
                      messages: convertToModelMessages(finalMessages),
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
                  return currentSystemPrompt
                    ? { system: currentSystemPrompt }
                    : {};
                }

                // Refresh and cache the updated system prompt
                currentSystemPrompt = await systemPrompt(
                  userId,
                  mode,
                  subscription,
                  userCustomization,
                  temporary,
                  chat?.finish_reason,
                );

                return {
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
              openai: {
                parallelToolCalls: false,
                ...(mode === "agent" && {
                  reasoningSummary: "detailed",
                  reasoningEffort: "medium",
                }),
              },
              openrouter: {
                ...(subscription === "free" && {
                  provider: {
                    sort: "price",
                  },
                }),
              },
            },
            headers: getAIHeaders(),
            experimental_transform: smoothStream({ chunking: "word" }),
            stopWhen: stepCountIs(mode === "ask" ? 5 : 10),
            onChunk: async (chunk) => {
              // Track all tool calls immediately (no throttle)
              if (chunk.chunk.type === "tool-call") {
                const command =
                  chunk.chunk.toolName === "web"
                    ? (chunk.chunk.input as any)?.command
                    : undefined;
                if (posthog) {
                  posthog.capture({
                    distinctId: userId,
                    event: "hackerai-" + (command || chunk.chunk.toolName),
                  });
                }
              }
            },
            onFinish: async ({ finishReason }) => {
              streamFinishReason = finishReason;
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

                // Always cleanup sandbox regardless of abort status
                const sandbox = getSandbox();
                if (sandbox) {
                  await pauseSandbox(sandbox);
                }

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
                    const messageToSave =
                      message.role === "assistant" &&
                      summarizationParts.length > 0
                        ? {
                            ...message,
                            parts: [...summarizationParts, ...message.parts],
                          }
                        : message;

                    await saveMessage({
                      chatId,
                      userId,
                      message: messageToSave,
                      extraFileIds:
                        message.role === "assistant" ? newFileIds : undefined,
                    });
                  }
                } else {
                  // For temporary chats, ensure temp stream row is removed backend-side
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
