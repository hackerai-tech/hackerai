import { generateText, Output, UIMessage, UIMessageStreamWriter } from "ai";
import { myProvider } from "@/lib/ai/providers";
import { z } from "zod";
import { isXaiSafetyError } from "@/lib/api/chat-stream-helpers";

const truncateMiddle = (text: string, maxLength: number): string => {
  if (text.length <= maxLength) return text;

  const halfLength = Math.floor((maxLength - 3) / 2); // -3 for "..."
  const start = text.substring(0, halfLength);
  const end = text.substring(text.length - halfLength);

  return `${start}...${end}`;
};

export const DEFAULT_TITLE_GENERATION_PROMPT_TEMPLATE = (
  message: string,
) => `### Task:
You are a helpful assistant that generates short, concise chat titles for an AI penetration testing assistant based on the first user message.

### Instructions:
1. Generate a short title (3-5 words) that accurately reflects the actual topic of the user's first message — whatever it is. Do NOT force a security/hacking framing onto unrelated topics (e.g., a question about cooking should get a cooking title, not a security one).
2. Generate the title in the SAME language as the user's first message (e.g., if the message is in Spanish, the title MUST be in Spanish; if in Russian, the title MUST be in Russian). Default to English only if the language cannot be determined.

### User Message:
${truncateMiddle(message, 8000)}`;

export const generateTitleFromUserMessage = async (
  truncatedMessages: UIMessage[],
): Promise<string | undefined> => {
  const firstMessage = truncatedMessages[0];
  const textContent = firstMessage.parts
    .filter((part: { type: string; text?: string }) => part.type === "text")
    .map((part: { type: string; text?: string }) => part.text || "")
    .join(" ");

  const { output } = await generateText({
    model: myProvider.languageModel("title-generator-model"),
    providerOptions: {
      xai: {
        // Disable storing the conversation in XAI's database
        store: false,
      },
    },
    output: Output.object({
      schema: z.object({
        title: z.string().describe("The generated title (3-5 words)"),
      }),
    }),
    messages: [
      {
        role: "user",
        content: DEFAULT_TITLE_GENERATION_PROMPT_TEMPLATE(textContent),
      },
    ],
  });

  return output?.title;
};

export const generateTitleFromUserMessageWithWriter = async (
  truncatedMessages: UIMessage[],
  writer: UIMessageStreamWriter,
): Promise<string | undefined> => {
  try {
    const chatTitle = await generateTitleFromUserMessage(truncatedMessages);

    writer.write({
      type: "data-title",
      data: { chatTitle },
      transient: true,
    });

    return chatTitle;
  } catch (error) {
    // Log error but don't propagate to keep main stream resilient
    // Suppress xAI safety check errors (expected for certain content)
    if (!isXaiSafetyError(error)) {
      console.error("Failed to generate or write chat title:", error);
    }
    return undefined;
  }
};
