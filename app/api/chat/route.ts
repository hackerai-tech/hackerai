import { convertToModelMessages, stepCountIs, streamText, UIMessage } from "ai";
import { openrouter } from "@openrouter/ai-sdk-provider";
import { systemPrompt } from "@/lib/system-prompt";
import { truncateMessagesToTokenLimit } from "@/lib/token-utils";
import { runTerminalCmd } from "@/lib/ai/tools/run-terminal-cmd";

// Allow streaming responses up to 300 seconds
export const maxDuration = 300;

export async function POST(req: Request) {
  const {
    messages,
    mode = "agent",
  }: { messages: UIMessage[]; mode?: "agent" | "ask" } = await req.json();

  const model = "anthropic/claude-sonnet-4";

  // Truncate messages to stay within token limit
  const truncatedMessages = truncateMessagesToTokenLimit(messages);

  const result = streamText({
    model: openrouter(model),
    system: systemPrompt(model),
    messages: convertToModelMessages(truncatedMessages),
    ...(mode === "agent" ? { tools: { runTerminalCmd } } : {}),
    abortSignal: req.signal,
    stopWhen: stepCountIs(5),
  });

  return result.toUIMessageStreamResponse();
}
