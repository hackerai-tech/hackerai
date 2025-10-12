import {
  convertToModelMessages,
  createUIMessageStream,
  stepCountIs,
  streamText,
  UIMessage,
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
  getCancellationStatus,
  prepareForNewStream,
  startStream,
} from "@/lib/db/actions";
import { v4 as uuidv4 } from "uuid";
import { processChatMessages } from "@/lib/chat/chat-processor";
import { createTrackedProvider } from "@/lib/ai/providers";
import { uploadSandboxFiles } from "@/lib/utils/sandbox-file-utils";
import { after } from "next/server";
import { createResumableStreamContext } from "resumable-stream";
import throttle from "throttleit";

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

      // Throttled cancellation check (max once per second)
      const checkCancellation = throttle(async () => {
        if (!temporary) {
          const status = await getCancellationStatus({ chatId });
          if (status?.canceled_at) {
            userStopSignal.abort();
          }
        }
      }, 1000);

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

          const result = streamText({
            model: trackedProvider.languageModel(selectedModel),
            system: currentSystemPrompt,
            messages: convertToModelMessages(processedMessages),
            tools,
            // Refresh system prompt when memory updates occur, cache and reuse until next update
            prepareStep: async ({ steps }) => {
              try {
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
                const command = (chunk.chunk.input as any)?.command;
                if (posthog) {
                  posthog.capture({
                    distinctId: userId,
                    event: "hackerai-" + (command || chunk.chunk.toolName),
                  });
                }
              }

              // Check for cancellation (throttled separately)
              await checkCancellation();
            },
            onAbort: () => {
              console.log("aborted");
            },
            onError: async (error) => {
              console.error("Error:", error);

              const sandbox = getSandbox();
              if (sandbox) {
                await pauseSandbox(sandbox);
              }
              await titlePromise;
            },
            onFinish: async ({ finishReason }) => {
              const sandbox = getSandbox();
              if (sandbox) {
                await pauseSandbox(sandbox);
              }

              const generatedTitle = await titlePromise;

              if (!temporary) {
                const mergedTodos = getTodoManager().mergeWith(
                  baseTodos,
                  assistantMessageId,
                );

                const shouldPersist = regenerate
                  ? true
                  : Boolean(
                      generatedTitle || finishReason || mergedTodos.length > 0,
                    );

                if (shouldPersist) {
                  await updateChat({
                    chatId,
                    title: generatedTitle,
                    finishReason,
                    todos: mergedTodos,
                    defaultModelSlug: mode,
                  });
                }

                // Clear both active_stream_id and canceled_at when finished
                // This is critical for stream resumption and cleanup
                await prepareForNewStream({ chatId });
              }
            },
          });

          writer.merge(
            result.toUIMessageStream({
              generateMessageId: () => assistantMessageId,
              onFinish: async ({ messages }) => {
                if (temporary) return;
                const newFileIds = getFileAccumulator().getAll();
                for (const message of messages) {
                  await saveMessage({
                    chatId,
                    userId,
                    message,
                    extraFileIds:
                      message.role === "assistant" ? newFileIds : undefined,
                  });
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
