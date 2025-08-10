import { convertToModelMessages, stepCountIs, streamText, UIMessage } from "ai";
import { openrouter } from "@openrouter/ai-sdk-provider";
import { systemPrompt } from "@/lib/system-prompt";

// Allow streaming responses up to 300 seconds
export const maxDuration = 300;

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const model = "anthropic/claude-sonnet-4";

  const result = streamText({
    model: openrouter(model),
    system: systemPrompt(model),
    messages: convertToModelMessages(messages),
    stopWhen: stepCountIs(10),
  });

  return result.toUIMessageStreamResponse();
}
