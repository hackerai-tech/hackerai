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

// Allow streaming responses up to 300 seconds
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const {
    messages,
    mode = "agent",
  }: { messages: UIMessage[]; mode?: "agent" | "ask" } = await req.json();

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

  // Create tools with user context and mode
  const { tools, getSandbox } = createTools(userID, mode);

  // Truncate messages to stay within token limit
  const truncatedMessages = truncateMessagesToTokenLimit(messages);

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      // Generate title in parallel if this is the start of a conversation
      const titlePromise =
        truncatedMessages.length === 1
          ? (async () => {
              const chatTitle = await generateTitleFromUserMessage(
                truncatedMessages,
                req.signal,
              );

              writer.write({
                type: "data-title",
                data: { chatTitle },
                transient: true,
              });
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
