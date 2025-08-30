import { generateObject, UIMessage, UIMessageStreamWriter } from "ai";
import { myProvider } from "@/lib/ai/providers";
import { z } from "zod";

export const getAIHeaders = () => ({
  "HTTP-Referer":
    process.env.NODE_ENV === "development"
      ? "https://test.hackerai.co"
      : "https://www.hackerai.co",
  "X-Title":
    process.env.NODE_ENV === "development" ? "HackerAI-Dev" : "HackerAI",
});

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
1. Generate a short title (3-5 words) based on the user's first message
2. Use the chat's primary language (default to English if multilingual)
3. Focus on security testing, hacking, or technical topics when relevant

### User Message:
${truncateMiddle(message, 8000)}`;

export const generateTitleFromUserMessage = async (
  truncatedMessages: UIMessage[],
  abortSignal: AbortSignal,
): Promise<string> => {
  const firstMessage = truncatedMessages[0];
  const textContent = firstMessage.parts
    .filter((part: { type: string; text?: string }) => part.type === "text")
    .map((part: { type: string; text?: string }) => part.text || "")
    .join(" ");

  const {
    object: { title },
  } = await generateObject({
    model: myProvider.languageModel("title-generator-model"),
    schema: z.object({
      title: z.string().describe("The generated title (3-5 words)"),
    }),
    headers: getAIHeaders(),
    messages: [
      {
        role: "user",
        content: DEFAULT_TITLE_GENERATION_PROMPT_TEMPLATE(textContent),
      },
    ],
    abortSignal,
  });

  return title;
};

export const generateTitleFromUserMessageWithWriter = async (
  truncatedMessages: UIMessage[],
  abortSignal: AbortSignal,
  writer: UIMessageStreamWriter,
): Promise<string | undefined> => {
  try {
    const chatTitle = await generateTitleFromUserMessage(
      truncatedMessages,
      abortSignal,
    );

    writer.write({
      type: "data-title",
      data: { chatTitle },
      transient: true,
    });

    return chatTitle;
  } catch (error) {
    // Log error but don't propagate to keep main stream resilient
    console.error("Failed to generate or write chat title:", error);
    return undefined;
  }
};
