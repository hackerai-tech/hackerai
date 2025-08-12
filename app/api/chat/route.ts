import { convertToModelMessages, stepCountIs, streamText, UIMessage } from "ai";
import { openrouter } from "@openrouter/ai-sdk-provider";
import { systemPrompt } from "@/lib/system-prompt";
import { truncateMessagesToTokenLimit } from "@/lib/token-utils";
import { createTools } from "@/lib/ai/tools";
import { pauseSandbox } from "@/lib/ai/tools/utils/sandbox";
import { isWorkOSConfigured } from "@/lib/auth-utils";
import { authkit } from "@workos-inc/authkit-nextjs";
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

  // Create tools with user context
  const { tools, getSandbox } = createTools(userID);

  // Truncate messages to stay within token limit
  const truncatedMessages = truncateMessagesToTokenLimit(messages);

  const result = streamText({
    model: openrouter(model),
    system: systemPrompt(model),
    messages: convertToModelMessages(truncatedMessages),
    ...(mode === "agent" ? { tools } : {}),
    abortSignal: req.signal,
    stopWhen: stepCountIs(5),
    onFinish: async () => {
      const sandbox = getSandbox();
      if (sandbox) {
        await pauseSandbox(sandbox);
      }
    },
  });

  return result.toUIMessageStreamResponse();
}
