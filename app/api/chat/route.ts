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
import { getUserID } from "@/lib/auth/server";
import { generateTitleFromUserMessage } from "@/lib/actions";
import { NextRequest } from "next/server";
import { myProvider } from "@/lib/ai/providers";
import type { ChatMode, ExecutionMode } from "@/types";
import { checkRateLimit } from "@/lib/rate-limit";
import { ChatSDKError } from "@/lib/errors";
import PostHogClient from "@/app/posthog";
import { geolocation } from "@vercel/functions";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const { messages, mode }: { messages: UIMessage[]; mode: ChatMode } =
      await req.json();

    // Get user ID from authenticated session or fallback to anonymous
    const userID = await getUserID(req);
    const userLocation = geolocation(req);

    // Check rate limit for the user
    await checkRateLimit(userID);

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
        // Create tools with user context, mode, and writer
        const { tools, getSandbox } = createTools(
          userID,
          writer,
          mode,
          executionMode,
          userLocation,
        );

        // Generate title in parallel if this is the start of a conversation
        const titlePromise =
          truncatedMessages.length === 1
            ? (async () => {
                try {
                  const chatTitle = await generateTitleFromUserMessage(
                    truncatedMessages,
                    req.signal,
                  );

                  writer.write({
                    type: "data-title",
                    data: { chatTitle },
                    transient: true,
                  });
                } catch (error) {
                  // Log error but don't propagate to keep main stream resilient
                  console.error(
                    "Failed to generate or write chat title:",
                    error,
                  );
                }
              })()
            : Promise.resolve();

        const result = streamText({
          model: model,
          system: systemPrompt(model.modelId, executionMode),
          messages: convertToModelMessages(truncatedMessages),
          tools,
          abortSignal: req.signal,
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
          onFinish: async () => {
            const sandbox = getSandbox();
            if (sandbox) {
              await pauseSandbox(sandbox);
            }
            await titlePromise;
          },
        });

        writer.merge(result.toUIMessageStream());
      },
    });

    return createUIMessageStreamResponse({ stream });
  } catch (error) {
    // Handle rate limiting and other ChatSDKErrors
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
