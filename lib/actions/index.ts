import { generateText, Output, UIMessage, UIMessageStreamWriter } from "ai";
import { myProvider } from "@/lib/ai/providers";
import { z } from "zod";
import { isXaiSafetyError } from "@/lib/api/chat-stream-helpers";

const MAX_GENERATED_TITLE_LENGTH = 100;
const TITLE_GENERATION_MAX_OUTPUT_TOKENS = 64;
const FALLBACK_TITLE_WORD_LIMIT = 5;
const IMAGE_ONLY_CHAT_TITLE = "New chat";

const truncateMiddle = (text: string, maxLength: number): string => {
  if (text.length <= maxLength) return text;

  const halfLength = Math.floor((maxLength - 3) / 2); // -3 for "..."
  const start = text.substring(0, halfLength);
  const end = text.substring(text.length - halfLength);

  return `${start}...${end}`;
};

const normalizeTitle = (title: unknown): string | undefined => {
  if (typeof title !== "string") return undefined;

  const normalized = title
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return undefined;

  return normalized.substring(0, MAX_GENERATED_TITLE_LENGTH);
};

const fallbackTitleFromMessage = (message: string): string | undefined => {
  const normalized = message.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;

  return normalizeTitle(
    normalized.split(" ").slice(0, FALLBACK_TITLE_WORD_LIMIT).join(" "),
  );
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
  const textContent = (firstMessage?.parts ?? [])
    .filter((part: { type: string; text?: string }) => part.type === "text")
    .map((part: { type: string; text?: string }) => part.text || "")
    .join(" ");
  const hasImage = (firstMessage?.parts ?? []).some(
    (part) => part.type === "file" && part.mediaType.startsWith("image/"),
  );

  if (!textContent.trim() && hasImage) {
    return IMAGE_ONLY_CHAT_TITLE;
  }

  const fallbackTitle = fallbackTitleFromMessage(textContent);

  try {
    const { output } = await generateText({
      model: myProvider.languageModel("title-generator-model"),
      providerOptions: {
        openrouter: {
          reasoning: { enabled: true, effort: "high" },
        },
        xai: {
          // Disable storing the conversation in XAI's database
          store: false,
        },
      },
      output: Output.object({
        schema: z.object({
          title: z
            .string()
            .trim()
            .min(1)
            .max(MAX_GENERATED_TITLE_LENGTH)
            .describe(
              "A concise chat title, 3-5 words, in the same language as the user message",
            ),
        }),
      }),
      temperature: 0,
      maxOutputTokens: TITLE_GENERATION_MAX_OUTPUT_TOKENS,
      maxRetries: 1,
      messages: [
        {
          role: "user",
          content: DEFAULT_TITLE_GENERATION_PROMPT_TEMPLATE(textContent),
        },
      ],
    });

    return normalizeTitle(output?.title) ?? fallbackTitle;
  } catch {
    return fallbackTitle;
  }
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
