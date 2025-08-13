import { generateObject, UIMessage } from "ai";
import { myProvider } from "@/lib/ai/providers";
import { z } from "zod";

export const DEFAULT_TITLE_GENERATION_PROMPT_TEMPLATE = (
  message: string,
) => `### Task:
You are a helpful assistant that generates short, concise chat titles based on the first user message.

### Instructions:
1. Generate a short title (3-5 words) based on the user's first message
2. Use the chatName tool to generate the title
3. Use the chat's primary language (default to English if multilingual)

### User Message:
${message}`;

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
    providerOptions: {
      openai: {
        store: false,
        parallelToolCalls: false,
      },
    },
    schema: z.object({
      title: z.string().describe("The generated title (3-5 words)"),
    }),
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
