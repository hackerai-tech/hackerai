import "server-only";

import {
  UIMessage,
  generateText,
  convertToModelMessages,
  LanguageModel,
} from "ai";
import { v4 as uuidv4 } from "uuid";
import {
  countMessagesTokens,
  getMaxTokensForSubscription,
} from "@/lib/token-utils";
import {
  extractAllFileIdsFromMessages,
  getFileTokensByIds,
} from "./file-token-utils";
import { SubscriptionTier } from "@/types";

// Keep last N messages unsummarized for context
const MESSAGES_TO_KEEP_UNSUMMARIZED = 2;

/**
 * Check and summarize messages if needed
 * This is the main entry point for the chat handler
 */
export const checkAndSummarizeIfNeeded = async (
  messages: UIMessage[],
  subscription: SubscriptionTier,
  languageModel: LanguageModel,
): Promise<{
  needsSummarization: boolean;
  summarizedMessages: UIMessage[];
  cutoffMessageId: string | null;
  summaryText: string | null;
}> => {
  // Check if summarization is needed
  if (messages.length <= MESSAGES_TO_KEEP_UNSUMMARIZED) {
    return {
      needsSummarization: false,
      summarizedMessages: messages,
      cutoffMessageId: null,
      summaryText: null,
    };
  }

  const fileIds = extractAllFileIdsFromMessages(messages);
  const tokens = await getFileTokensByIds(fileIds as any);
  const totalTokens = countMessagesTokens(messages, tokens);
  const threshold = getMaxTokensForSubscription(subscription);

  if (totalTokens <= threshold) {
    return {
      needsSummarization: false,
      summarizedMessages: messages,
      cutoffMessageId: null,
      summaryText: null,
    };
  }

  // Keep last N messages unsummarized
  const lastMessages = messages.slice(-MESSAGES_TO_KEEP_UNSUMMARIZED);
  const messagesToSummarize = messages.slice(0, -MESSAGES_TO_KEEP_UNSUMMARIZED);

  if (messagesToSummarize.length === 0) {
    return {
      needsSummarization: false,
      summarizedMessages: messages,
      cutoffMessageId: null,
      summaryText: null,
    };
  }

  // The cutoff message ID is the last message that was summarized
  const cutoffMessageId =
    messagesToSummarize[messagesToSummarize.length - 1].id;

  // Generate summary using AI
  let summaryText: string;
  try {
    const result = await generateText({
      model: languageModel,
      system:
        "Summarize the following conversation concisely, preserving key context, decisions, technical details, and important information. The summary should be comprehensive but significantly shorter than the original.",
      messages: [
        ...convertToModelMessages(messagesToSummarize),
        {
          role: "user",
          content:
            "Please provide a concise summary of the above conversation.",
        },
      ],
    });
    summaryText = result.text;
  } catch (error) {
    console.error("[Summarization] Failed to generate summary:", error);
    summaryText = `[Summary of ${messagesToSummarize.length} messages in conversation]`;
  }

  // Create summary message with XML tags
  const summaryMessage: UIMessage = {
    id: uuidv4(),
    role: "user",
    parts: [
      {
        type: "text",
        text: `<conversation_summary>\n${summaryText}\n</conversation_summary>`,
      },
    ],
  };

  return {
    needsSummarization: true,
    summarizedMessages: [summaryMessage, ...lastMessages],
    cutoffMessageId,
    summaryText,
  };
};
