import "server-only";

import {
  UIMessage,
  UIMessageStreamWriter,
  generateText,
  convertToModelMessages,
  LanguageModel,
} from "ai";
import { v4 as uuidv4 } from "uuid";
import {
  getMaxTokensForSubscription,
  countMessagesTokens,
} from "@/lib/token-utils";
import { SubscriptionTier, ChatMode } from "@/types";
import {
  writeSummarizationStarted,
  writeSummarizationCompleted,
} from "@/lib/utils/stream-writer-utils";
import { saveChatSummary } from "@/lib/db/actions";
import type { Id } from "@/convex/_generated/dataModel";

import {
  MESSAGES_TO_KEEP_UNSUMMARIZED,
  SUMMARIZATION_THRESHOLD_PERCENTAGE,
} from "./constants";
import { getSummarizationPrompt } from "./helpers";

export {
  MESSAGES_TO_KEEP_UNSUMMARIZED,
  SUMMARIZATION_THRESHOLD_PERCENTAGE,
} from "./constants";
export {
  AGENT_SUMMARIZATION_PROMPT,
  ASK_SUMMARIZATION_PROMPT,
} from "./prompts";
export { getSummarizationPrompt } from "./helpers";

/**
 * Check and summarize messages if needed
 * This is the main entry point for the chat handler
 * Handles the full summarization flow: check -> shimmer -> generate -> save -> complete
 * @param writer - Stream writer for sending status updates to the client
 * @param chatId - Chat ID for saving the summary (null for temporary chats)
 */
export const checkAndSummarizeIfNeeded = async (
  uiMessages: UIMessage[],
  subscription: SubscriptionTier,
  languageModel: LanguageModel,
  mode: ChatMode,
  writer: UIMessageStreamWriter,
  chatId: string | null,
  fileTokens: Record<Id<"files">, number> = {},
): Promise<{
  needsSummarization: boolean;
  summarizedMessages: UIMessage[];
  cutoffMessageId: string | null;
  summaryText: string | null;
}> => {
  // Early return if not enough messages to summarize
  if (uiMessages.length <= MESSAGES_TO_KEEP_UNSUMMARIZED) {
    return {
      needsSummarization: false,
      summarizedMessages: uiMessages,
      cutoffMessageId: null,
      summaryText: null,
    };
  }

  // Count tokens using UIMessages with proper file token handling
  const totalTokens = countMessagesTokens(uiMessages, fileTokens);
  const maxTokens = getMaxTokensForSubscription(subscription);
  const threshold = Math.floor(maxTokens * SUMMARIZATION_THRESHOLD_PERCENTAGE);

  if (totalTokens <= threshold) {
    return {
      needsSummarization: false,
      summarizedMessages: uiMessages,
      cutoffMessageId: null,
      summaryText: null,
    };
  }

  // Keep last N messages unsummarized
  const lastMessages = uiMessages.slice(-MESSAGES_TO_KEEP_UNSUMMARIZED);
  const messagesToSummarize = uiMessages.slice(
    0,
    -MESSAGES_TO_KEEP_UNSUMMARIZED,
  );

  if (messagesToSummarize.length === 0) {
    return {
      needsSummarization: false,
      summarizedMessages: uiMessages,
      cutoffMessageId: null,
      summaryText: null,
    };
  }

  // The cutoff message ID is the last message that was summarized
  const cutoffMessageId =
    messagesToSummarize[messagesToSummarize.length - 1].id;

  // Show shimmer indicator BEFORE generating summary
  writeSummarizationStarted(writer);

  // Generate summary using AI
  let summaryText: string;
  try {
    const result = await generateText({
      model: languageModel,
      system: getSummarizationPrompt(mode),
      providerOptions: {
        xai: {
          // Disable storing the conversation in XAI's database
          store: false,
        },
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
        text: `<context_summary>\n${summaryText}\n</context_summary>`,
      },
    ],
  };

  // Save the summary to the database (non-temporary chats only)
  if (chatId) {
    try {
      await saveChatSummary({
        chatId,
        summaryText,
        summaryUpToMessageId: cutoffMessageId,
      });
    } catch (error) {
      console.error("[Summarization] Failed to save summary:", error);
      // Continue anyway - the summary was generated successfully
    }
  }

  // Always write completed status to clear UI shimmer
  writeSummarizationCompleted(writer);

  return {
    needsSummarization: true,
    summarizedMessages: [summaryMessage, ...lastMessages],
    cutoffMessageId,
    summaryText,
  };
};
