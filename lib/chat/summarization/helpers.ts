import {
  UIMessage,
  generateText,
  convertToModelMessages,
  LanguageModel,
} from "ai";
import { v4 as uuidv4 } from "uuid";
import {
  getMaxTokensForSubscription,
  countMessagesTokens,
} from "@/lib/token-utils";
import { saveChatSummary } from "@/lib/db/actions";
import { myProvider } from "@/lib/ai/providers";
import { SubscriptionTier, ChatMode, Todo } from "@/types";
import type { Id } from "@/convex/_generated/dataModel";

import {
  MESSAGES_TO_KEEP_UNSUMMARIZED,
  SUMMARIZATION_THRESHOLD_PERCENTAGE,
} from "./constants";
import {
  AGENT_SUMMARIZATION_PROMPT,
  ASK_SUMMARIZATION_PROMPT,
} from "./prompts";

export interface SummarizationResult {
  needsSummarization: boolean;
  summarizedMessages: UIMessage[];
  cutoffMessageId: string | null;
  summaryText: string | null;
}

export const NO_SUMMARIZATION = (
  messages: UIMessage[],
): SummarizationResult => ({
  needsSummarization: false,
  summarizedMessages: messages,
  cutoffMessageId: null,
  summaryText: null,
});

export const getSummarizationPrompt = (mode: ChatMode): string =>
  mode === "agent" ? AGENT_SUMMARIZATION_PROMPT : ASK_SUMMARIZATION_PROMPT;

export const isAboveTokenThreshold = (
  uiMessages: UIMessage[],
  subscription: SubscriptionTier,
  fileTokens: Record<Id<"files">, number>,
  systemPromptTokens: number = 0,
  providerInputTokens: number = 0,
): boolean => {
  const maxTokens = getMaxTokensForSubscription(subscription);
  const threshold = Math.floor(maxTokens * SUMMARIZATION_THRESHOLD_PERCENTAGE);

  // If the provider already reported input tokens exceeding the threshold,
  // trust that over our local gpt-tokenizer estimate (which misses tool
  // schemas, formatting overhead, and uses a different tokenizer).
  if (providerInputTokens > threshold) {
    return true;
  }

  const totalTokens =
    countMessagesTokens(uiMessages, fileTokens) + systemPromptTokens;
  return totalTokens > threshold;
};

export const splitMessages = (
  uiMessages: UIMessage[],
): { messagesToSummarize: UIMessage[]; lastMessages: UIMessage[] } => ({
  messagesToSummarize: uiMessages.slice(0, -MESSAGES_TO_KEEP_UNSUMMARIZED),
  lastMessages: uiMessages.slice(-MESSAGES_TO_KEEP_UNSUMMARIZED),
});

export const isSummaryMessage = (message: UIMessage): boolean => {
  if (message.parts.length === 0) return false;
  const firstPart = message.parts[0];
  if (firstPart.type !== "text") return false;
  return (firstPart as { type: "text"; text: string }).text.startsWith(
    "<context_summary>",
  );
};

export const extractSummaryText = (message: UIMessage): string | null => {
  if (!isSummaryMessage(message)) return null;
  const text = (message.parts[0] as { type: "text"; text: string }).text;
  const match = text.match(
    /<context_summary>\n?([\s\S]*?)\n?<\/context_summary>/,
  );
  return match ? match[1] : null;
};

export const generateSummaryText = async (
  messagesToSummarize: UIMessage[],
  _languageModel: LanguageModel,
  mode: ChatMode,
  abortSignal?: AbortSignal,
  existingSummaryText?: string,
): Promise<string> => {
  const basePrompt = getSummarizationPrompt(mode);
  const system = existingSummaryText
    ? `${basePrompt}\n\nIMPORTANT: You are performing an INCREMENTAL summarization. A previous summary of earlier conversation exists below. Your job is to produce a single, unified summary that merges the previous summary with the NEW messages provided. Do NOT summarize the summary — instead, integrate new information into a comprehensive updated summary.\n\n<previous_summary>\n${existingSummaryText}\n</previous_summary>`
    : basePrompt;

  const result = await generateText({
    model: myProvider.languageModel("summarization-model"),
    system,
    abortSignal,
    providerOptions: {
      xai: { store: false },
    },
    messages: [
      ...(await convertToModelMessages(messagesToSummarize)),
      {
        role: "user",
        content:
          "Summarize the above conversation using the structured format specified in your instructions. Output ONLY the summary — do not continue the conversation or role-play as the assistant.",
      },
    ],
  });
  return result.text;
};

export const buildSummaryMessage = (
  summaryText: string,
  todos: Todo[] = [],
): UIMessage => {
  let text = `<context_summary>\n${summaryText}\n</context_summary>`;

  if (todos.length > 0) {
    const todoLines = todos
      .map((todo) => `- [${todo.status}] ${todo.content}`)
      .join("\n");
    text += `\n<current_todos>\n${todoLines}\n</current_todos>`;
  }

  return {
    id: uuidv4(),
    role: "user",
    parts: [{ type: "text", text }],
  };
};

export const persistSummary = async (
  chatId: string | null,
  summaryText: string,
  cutoffMessageId: string,
): Promise<void> => {
  if (!chatId) return;

  try {
    await saveChatSummary({
      chatId,
      summaryText,
      summaryUpToMessageId: cutoffMessageId,
    });
  } catch (error) {
    console.error("[Summarization] Failed to save summary:", error);
  }
};
