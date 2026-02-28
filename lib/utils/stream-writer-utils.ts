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

export const createSummarizationCompletedPart = (opts?: {
  messageSummary?: string;
  stepSummary?: string;
}): UIMessagePart<any, any> => ({
  type: "data-summarization" as const,
  id: "summarization-status",
  data: {
    status: "completed",
    message: "Chat context summarized",
    ...(opts?.messageSummary && { messageSummary: opts.messageSummary }),
    ...(opts?.stepSummary && { stepSummary: opts.stepSummary }),
  },
});

export type SummarizationEvent = {
  stepIndex: number;
  messageSummary?: string;
  stepSummary?: string;
};

export function injectSummarizationParts(
  parts: UIMessagePart<any, any>[],
  events: SummarizationEvent[],
): UIMessagePart<any, any>[] {
  if (events.length === 0) return parts;
  const result: UIMessagePart<any, any>[] = [];
  let stepStartCount = 0;
  for (const part of parts) {
    if ((part as { type: string }).type === "step-start") {
      const match = events.find((s) => s.stepIndex === stepStartCount);
      if (match) {
        result.push(
          createSummarizationCompletedPart({
            messageSummary: match.messageSummary,
            stepSummary: match.stepSummary,
          }),
        );
      }
      stepStartCount++;
    }
    result.push(part);
  }
  return result;
}

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
      bucketType: "session" | "weekly";
      remainingPercent: number;
      resetTime: string;
      subscription: SubscriptionTier;
    }
  | {
      // Paid users: extra usage is now being consumed
      warningType: "extra-usage-active";
      bucketType: "session" | "weekly";
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
