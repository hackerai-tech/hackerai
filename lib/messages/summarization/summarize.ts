import "server-only";

import {
  UIMessage,
  generateText,
  convertToModelMessages,
  LanguageModel,
  ModelMessage,
} from "ai";
import { v4 as uuidv4 } from "uuid";
import { getMaxTokensForSubscription } from "@/lib/token-utils";
import type { SubscriptionTier, ChatMode } from "@/types";
import type { SummarizationResult } from "./types";
import {
  MESSAGES_TO_KEEP_UNSUMMARIZED,
  SUMMARIZATION_THRESHOLD_PERCENTAGE,
} from "./constants";
import { getSummarizationPrompt } from "./prompts";
import { countModelMessageTokens } from "./token-counter";

export const checkAndSummarizeIfNeeded = async (
  currentModelMessages: ModelMessage[],
  uiMessages: UIMessage[],
  subscription: SubscriptionTier,
  languageModel: LanguageModel,
  mode: ChatMode,
): Promise<SummarizationResult> => {
  if (uiMessages.length <= MESSAGES_TO_KEEP_UNSUMMARIZED) {
    return {
      needsSummarization: false,
      summarizedMessages: uiMessages,
      cutoffMessageId: null,
      summaryText: null,
    };
  }

  const totalTokens = countModelMessageTokens(currentModelMessages);
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

  const cutoffMessageId =
    messagesToSummarize[messagesToSummarize.length - 1].id;

  let summaryText: string;
  try {
    const result = await generateText({
      model: languageModel,
      system: getSummarizationPrompt(mode),
      providerOptions: {
        xai: {
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

  return {
    needsSummarization: true,
    summarizedMessages: [summaryMessage, ...lastMessages],
    cutoffMessageId,
    summaryText,
  };
};
