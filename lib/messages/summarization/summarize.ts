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
import type { SummarizationResult, SummaryChunk } from "./types";
import {
  MESSAGES_TO_KEEP_UNSUMMARIZED,
  SUMMARIZATION_THRESHOLD_PERCENTAGE,
  SUMMARIZATION_CHUNK_SIZE,
} from "./constants";
import {
  getSummarizationPrompt,
  buildPriorContextMessage,
  CHUNK_SUMMARIZATION_INSTRUCTION,
} from "./prompts";
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
  summaryChunks: null,
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

  // Extract text from existing summaries to provide as prior context
  const priorSummaryTexts = existingSummaries
    .map((msg) => {
      const textPart = msg.parts?.find(
        (p) => p.type === "text" && p.text?.includes("<context_summary>"),
      );
      return textPart?.type === "text" ? (textPart.text ?? "") : "";
    })
    .filter(Boolean);

  const priorContextMessage =
    priorSummaryTexts.length > 0
      ? [
          {
            role: "user" as const,
            content: buildPriorContextMessage(priorSummaryTexts),
          },
        ]
      : [];

  const summaryChunks: SummaryChunk[] = await Promise.all(
    chunks.map(async (chunk) => {
      const lastMessageId = chunk[chunk.length - 1].id;
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
            ...priorContextMessage,
            ...(await convertToModelMessages(chunk)),
            {
              role: "user",
              content: CHUNK_SUMMARIZATION_INSTRUCTION,
            },
          ],
        });
        return { text: result.text, lastMessageId };
      } catch (error) {
        console.error("[Summarization] Failed to generate summary:", error);
        return {
          text: `[Summary of ${chunk.length} messages in conversation]`,
          lastMessageId,
        };
      }
    }),
  );

  const newSummaryMessages: UIMessage[] = summaryChunks.map((chunk) => ({
    id: uuidv4(),
    role: "user",
    parts: [
      {
        type: "text",
        text: `<context_summary>\n${chunk.text}\n</context_summary>`,
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
    summaryChunks,
  };
};
