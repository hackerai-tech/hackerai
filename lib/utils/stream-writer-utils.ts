import "server-only";

import { UIMessagePart, UIMessageStreamWriter } from "ai";
import type { ChatMode, SubscriptionTier } from "@/types";

// Upload status notifications
export const writeUploadStartStatus = (writer: UIMessageStreamWriter): void => {
  writer.write({
    type: "data-upload-status",
    data: {
      message: "Uploading attachments to the computer",
      isUploading: true,
    },
    transient: true,
  });
};

export const writeUploadCompleteStatus = (
  writer: UIMessageStreamWriter,
): void => {
  writer.write({
    type: "data-upload-status",
    data: {
      message: "",
      isUploading: false,
    },
    transient: true,
  });
};

// Summarization notifications
export const writeSummarizationStarted = (
  writer: UIMessageStreamWriter,
): void => {
  writer.write({
    type: "data-summarization",
    id: "summarization-status",
    data: {
      status: "started",
      message: "Summarizing chat context",
    },
    transient: true, // Don't persist started state - only show during processing
  });
};

export const writeSummarizationCompleted = (
  writer: UIMessageStreamWriter,
): void => {
  writer.write({
    type: "data-summarization",
    id: "summarization-status",
    data: {
      status: "completed",
      message: "Chat context summarized",
    },
  });
};

export const createSummarizationCompletedPart = (): UIMessagePart<
  any,
  any
> => ({
  type: "data-summarization" as const,
  id: "summarization-status",
  data: {
    status: "completed",
    message: "Chat context summarized",
  },
});

/**
 * Finds the insertion index for the summarization part based on which step
 * summarization happened at. Uses step-start parts as positional markers
 * so the badge appears at the correct position in the conversation.
 */
export const findSummarizationInsertIndex = (
  parts: UIMessagePart<any, any>[],
  stepNumber: number,
): number => {
  let stepStartsSeen = 0;
  for (let i = 0; i < parts.length; i++) {
    if ((parts[i] as { type: string }).type === "step-start") {
      if (stepStartsSeen === stepNumber) {
        return i;
      }
      stepStartsSeen++;
    }
  }
  return 0;
};

// Unified rate limit warning data types
export type RateLimitWarningData =
  | {
      // Free users: sliding window (remaining count)
      warningType: "sliding-window";
      remaining: number;
      resetTime: string;
      mode: ChatMode;
      subscription: SubscriptionTier;
    }
  | {
      // Paid users: token bucket (remaining percentage)
      warningType: "token-bucket";
      bucketType: "monthly";
      remainingPercent: number;
      resetTime: string;
      subscription: SubscriptionTier;
      severity?: "info" | "warning";
      usedDollars?: number;
      limitDollars?: number;
    }
  | {
      // Paid users: extra usage is now being consumed
      warningType: "extra-usage-active";
      bucketType: "monthly";
      resetTime: string;
      subscription: SubscriptionTier;
    };

// Unified rate limit warning notification
export const writeRateLimitWarning = (
  writer: UIMessageStreamWriter,
  data: RateLimitWarningData,
): void => {
  writer.write({
    type: "data-rate-limit-warning",
    data,
    transient: true,
  });
};

export const writeAutoContinue = (writer: UIMessageStreamWriter): void => {
  writer.write({
    type: "data-auto-continue",
    data: { shouldContinue: true },
  });
};
