import "server-only";

import { UIMessage, UIMessageStreamWriter, LanguageModel } from "ai";
import { SubscriptionTier, ChatMode, Todo } from "@/types";
import {
  writeSummarizationStarted,
  writeSummarizationCompleted,
} from "@/lib/utils/stream-writer-utils";
import type { Id } from "@/convex/_generated/dataModel";

import { MESSAGES_TO_KEEP_UNSUMMARIZED } from "./constants";
import {
  NO_SUMMARIZATION,
  isAboveTokenThreshold,
  splitMessages,
  generateSummaryText,
  buildSummaryMessage,
  persistSummary,
} from "./helpers";
import type { SummarizationResult } from "./helpers";

export type { SummarizationResult } from "./helpers";

export const checkAndSummarizeIfNeeded = async (
  uiMessages: UIMessage[],
  subscription: SubscriptionTier,
  languageModel: LanguageModel,
  mode: ChatMode,
  writer: UIMessageStreamWriter,
  chatId: string | null,
  fileTokens: Record<Id<"files">, number> = {},
  todos: Todo[] = [],
): Promise<SummarizationResult> => {
  if (uiMessages.length <= MESSAGES_TO_KEEP_UNSUMMARIZED) {
    return NO_SUMMARIZATION(uiMessages);
  }

  if (!isAboveTokenThreshold(uiMessages, subscription, fileTokens)) {
    return NO_SUMMARIZATION(uiMessages);
  }

  const { messagesToSummarize, lastMessages } = splitMessages(uiMessages);

  const cutoffMessageId =
    messagesToSummarize[messagesToSummarize.length - 1].id;

  writeSummarizationStarted(writer);

  const summaryText = await generateSummaryText(
    messagesToSummarize,
    languageModel,
    mode,
  );
  const summaryMessage = buildSummaryMessage(summaryText, todos);

  await persistSummary(chatId, summaryText, cutoffMessageId);

  writeSummarizationCompleted(writer);

  return {
    needsSummarization: true,
    summarizedMessages: [summaryMessage, ...lastMessages],
    cutoffMessageId,
    summaryText,
  };
};
