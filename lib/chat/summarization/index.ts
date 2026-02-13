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
  isSummaryMessage,
  extractSummaryText,
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
  abortSignal?: AbortSignal,
): Promise<SummarizationResult> => {
  // Detect and separate synthetic summary message from real messages
  let realMessages: UIMessage[];
  let existingSummaryText: string | null = null;

  if (uiMessages.length > 0 && isSummaryMessage(uiMessages[0])) {
    realMessages = uiMessages.slice(1);
    existingSummaryText = extractSummaryText(uiMessages[0]);
  } else {
    realMessages = uiMessages;
  }

  // Guard: need enough real messages to split
  if (realMessages.length <= MESSAGES_TO_KEEP_UNSUMMARIZED) {
    return NO_SUMMARIZATION(uiMessages);
  }

  // Check token threshold on full messages (including summary) to determine need
  if (!isAboveTokenThreshold(uiMessages, subscription, fileTokens)) {
    return NO_SUMMARIZATION(uiMessages);
  }

  // Split only real messages so cutoff always references a DB message
  const { messagesToSummarize, lastMessages } = splitMessages(realMessages);

  const cutoffMessageId =
    messagesToSummarize[messagesToSummarize.length - 1].id;

  writeSummarizationStarted(writer);

  try {
    const summaryText = await generateSummaryText(
      messagesToSummarize,
      languageModel,
      mode,
      abortSignal,
      existingSummaryText ?? undefined,
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
  } catch (error) {
    if (abortSignal?.aborted) {
      throw error;
    }
    console.error("[Summarization] Failed:", error);
    writeSummarizationCompleted(writer);
    return NO_SUMMARIZATION(uiMessages);
  }
};
