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
): boolean => {
  const totalTokens = countMessagesTokens(uiMessages, fileTokens);
  const maxTokens = getMaxTokensForSubscription(subscription);
  const threshold = Math.floor(maxTokens * SUMMARIZATION_THRESHOLD_PERCENTAGE);
  return totalTokens > threshold;
};

export const splitMessages = (
  uiMessages: UIMessage[],
): { messagesToSummarize: UIMessage[]; lastMessages: UIMessage[] } => ({
  messagesToSummarize: uiMessages.slice(0, -MESSAGES_TO_KEEP_UNSUMMARIZED),
  lastMessages: uiMessages.slice(-MESSAGES_TO_KEEP_UNSUMMARIZED),
});

export const generateSummaryText = async (
  messagesToSummarize: UIMessage[],
  languageModel: LanguageModel,
  mode: ChatMode,
): Promise<string> => {
  try {
    const result = await generateText({
      model: languageModel,
      system: getSummarizationPrompt(mode),
      providerOptions: {
        xai: { store: false },
      },
      messages: [
        ...(await convertToModelMessages(messagesToSummarize)),
        {
          role: "user",
          content:
            "Provide a technically precise summary of the above conversation segment that preserves all operational security context while keeping the summary concise and to the point.",
        },
      ],
    });
    return result.text;
  } catch (error) {
    console.error("[Summarization] Failed to generate summary:", error);
    return `[Summary of ${messagesToSummarize.length} messages in conversation]`;
  }
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
