import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  UIMessage,
  smoothStream,
} from "ai";
import { systemPrompt } from "@/lib/system-prompt";
import { truncateMessagesToTokenLimit } from "@/lib/token-utils";
import { createTools } from "@/lib/ai/tools";
import { pauseSandbox } from "@/lib/ai/tools/utils/sandbox";
import { generateTitleFromUserMessageWithWriter } from "@/lib/actions";
import { getUserID } from "@/lib/auth/get-user-id";
import { NextRequest } from "next/server";
import { myProvider } from "@/lib/ai/providers";
import type { ChatMode, ExecutionMode, Todo } from "@/types";
import { checkRateLimit } from "@/lib/rate-limit";
import { ChatSDKError } from "@/lib/errors";
import PostHogClient from "@/app/posthog";
import { geolocation } from "@vercel/functions";
import { getAIHeaders } from "@/lib/actions";
import {
  handleInitialChatAndUserMessage,
  saveMessage,
  updateChat,
  updateChatTodos,
} from "@/lib/db/actions";
import { v4 as uuidv4 } from "uuid";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const {
      messages,
      mode,
      todos,
      chatId,
      regenerate,
    }: {
      messages: UIMessage[];
      mode: ChatMode;
      chatId: string;
      todos?: Todo[];
      regenerate?: boolean;
    } = await req.json();

    const userID = await getUserID(req);
    const userLocation = geolocation(req);

    // Check rate limit for the user
    await checkRateLimit(userID);

    // Handle initial chat setup, regeneration, and save user message
    const { isNewChat } = await handleInitialChatAndUserMessage({
      chatId,
      userId: userID,
      messages,
      regenerate,
    });

    // Determine execution mode from environment variable
    const executionMode: ExecutionMode =
      (process.env.TERMINAL_EXECUTION_MODE as ExecutionMode) || "local";

    // Truncate messages to stay within token limit (processing is now done on frontend)
    const truncatedMessages = truncateMessagesToTokenLimit(messages);

    const model = myProvider.languageModel("agent-model");

    // Capture analytics event
    const posthog = PostHogClient();
    if (posthog) {
      posthog.capture({
        distinctId: userID,
        event: "hackerai-" + mode,
      });
    }

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        const { tools, getSandbox, getTodoManager } = createTools(
          userID,
          writer,
          mode,
          executionMode,
          userLocation,
          todos,
        );

        // Generate title in parallel if this is a new chat
        const titlePromise = isNewChat
          ? generateTitleFromUserMessageWithWriter(
              truncatedMessages,
              req.signal,
              writer,
            )
          : Promise.resolve(undefined);

        const result = streamText({
          model: model,
          system: systemPrompt(model.modelId, mode, executionMode),
          messages: convertToModelMessages(truncatedMessages),
          tools,
          abortSignal: req.signal,
          headers: getAIHeaders(),
          experimental_transform: smoothStream({ chunking: "word" }),
          stopWhen: stepCountIs(25),
          onChunk: async (chunk) => {
            if (chunk.chunk.type === "tool-call") {
              if (posthog) {
                posthog.capture({
                  distinctId: userID,
                  event: "hackerai-" + chunk.chunk.toolName,
                });
              }
            }
          },
          onError: async (error) => {
            console.error("Error:", error);

            // Perform same cleanup as onFinish to prevent resource leaks
            const sandbox = getSandbox();
            if (sandbox) {
              await pauseSandbox(sandbox);
            }
            await titlePromise;
          },
          onFinish: async ({ finishReason }) => {
            const generatedTitle = await titlePromise;
            const currentTodos = getTodoManager().getAllTodos();

            if (generatedTitle || finishReason || currentTodos.length > 0) {
              await updateChat({
                chatId,
                title: generatedTitle,
                finishReason,
                todos: currentTodos.length > 0 ? currentTodos : undefined,
              });
            }
          },
        });

        writer.merge(
          result.toUIMessageStream({
            onFinish: async ({ isAborted }) => {
              if (isAborted) {
                console.log("Stream was aborted 1");
                // Handle abort-specific cleanup
                const generatedTitle = await titlePromise;
                const currentTodos = getTodoManager().getAllTodos();

                if (generatedTitle || currentTodos.length > 0) {
                  await updateChat({
                    chatId,
                    title: generatedTitle,
                    finishReason: "abort",
                    todos: currentTodos.length > 0 ? currentTodos : undefined,
                  });
                }
              } else {
                console.log("Stream completed normally");
                // Handle normal completion
              }

              const sandbox = getSandbox();
              if (sandbox) {
                await pauseSandbox(sandbox);
              }
            },
          }),
        );
      },
      generateId: () => uuidv4(),
      onFinish: async ({ messages }) => {
        for (const message of messages) {
          await saveMessage({
            chatId,
            message,
          });
        }
      },
    });

    return createUIMessageStreamResponse({ stream });
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
}
