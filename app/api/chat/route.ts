import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  UIMessage,
} from "ai";
import { openrouter } from "@openrouter/ai-sdk-provider";
import { systemPrompt } from "@/lib/system-prompt";
import { truncateMessagesToTokenLimit } from "@/lib/token-utils";
import { createTools } from "@/lib/ai/tools";
import { pauseSandbox } from "@/lib/ai/tools/utils/sandbox";
import { isWorkOSConfigured } from "@/lib/auth-utils";
import { authkit } from "@workos-inc/authkit-nextjs";
import { generateTitleFromUserMessage } from "@/lib/actions";
import { NextRequest } from "next/server";
import type { ChatMode } from "@/types/chat";

// Allow streaming responses up to 300 seconds
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const { messages, mode }: { messages: UIMessage[]; mode: ChatMode } =
    await req.json();

  const model = "anthropic/claude-sonnet-4";

  // Get user ID from authenticated session or fallback to anonymous
  const getUserID = async (): Promise<string> => {
    if (!isWorkOSConfigured()) return "anonymous";

    try {
      const { session } = await authkit(req);
      return session?.user?.id || "anonymous";
    } catch (error) {
      console.error("Failed to get user session:", error);
      return "anonymous";
    }
  };

  const userID = await getUserID();

  // Truncate messages to stay within token limit
  const truncatedMessages = truncateMessagesToTokenLimit(messages);

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      // Create tools with user context, mode, and writer
      const { tools, getSandbox } = createTools(userID, writer, mode);

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
                console.error("Failed to generate or write chat title:", error);
              }
            })()
          : Promise.resolve();

      const result = streamText({
        model: openrouter(model),
        system: systemPrompt(model),
        messages: convertToModelMessages(truncatedMessages),
        tools,
        abortSignal: req.signal,
        stopWhen: stepCountIs(25),
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
}
