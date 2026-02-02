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
  SUMMARIZATION_CHUNK_SIZE,
} from "./constants";
import { getSummarizationPrompt } from "./prompts";
import { countModelMessageTokens } from "./token-counter";

export const isContextSummaryMessage = (msg: UIMessage): boolean =>
  msg.parts?.some(
    (p) => p.type === "text" && p.text?.includes("<context_summary>"),
  ) ?? false;

const chunkArray = <T>(arr: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
};

const noOpResult = (uiMessages: UIMessage[]): SummarizationResult => ({
  needsSummarization: false,
  summarizedMessages: uiMessages,
  cutoffMessageId: null,
  summaryTexts: null,
});

export const checkAndSummarizeIfNeeded = async (
  currentModelMessages: ModelMessage[],
  uiMessages: UIMessage[],
  subscription: SubscriptionTier,
  languageModel: LanguageModel,
  mode: ChatMode,
): Promise<SummarizationResult> => {
  if (uiMessages.length <= MESSAGES_TO_KEEP_UNSUMMARIZED) {
    return noOpResult(uiMessages);
  }

  const totalTokens = countModelMessageTokens(currentModelMessages);
  const maxTokens = getMaxTokensForSubscription(subscription);
  const threshold = Math.floor(maxTokens * SUMMARIZATION_THRESHOLD_PERCENTAGE);

  if (totalTokens <= threshold) {
    return noOpResult(uiMessages);
  }

  const lastMessages = uiMessages.slice(-MESSAGES_TO_KEEP_UNSUMMARIZED);
  const candidateMessages = uiMessages.slice(
    0,
    -MESSAGES_TO_KEEP_UNSUMMARIZED,
  );

  if (candidateMessages.length === 0) {
    return noOpResult(uiMessages);
  }

  const existingSummaries = candidateMessages.filter(isContextSummaryMessage);
  const rawMessages = candidateMessages.filter(
    (msg) => !isContextSummaryMessage(msg),
  );

  if (rawMessages.length === 0) {
    return noOpResult(uiMessages);
  }

  const cutoffMessageId = rawMessages[rawMessages.length - 1].id;
  const chunks = chunkArray(rawMessages, SUMMARIZATION_CHUNK_SIZE);

  const summaryTexts = await Promise.all(
    chunks.map(async (chunk) => {
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
            ...(await convertToModelMessages(chunk)),
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
        return `[Summary of ${chunk.length} messages in conversation]`;
      }
    }),
  );

  const newSummaryMessages: UIMessage[] = summaryTexts.map((text) => ({
    id: uuidv4(),
    role: "user",
    parts: [
      {
        type: "text",
        text: `<context_summary>\n${text}\n</context_summary>`,
      },
    ],
  }));

  return {
    needsSummarization: true,
    summarizedMessages: [
      ...existingSummaries,
      ...newSummaryMessages,
      ...lastMessages,
    ],
    cutoffMessageId,
    summaryTexts,
  };
};
