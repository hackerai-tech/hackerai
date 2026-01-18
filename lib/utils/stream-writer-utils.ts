import "server-only";

import { UIMessagePart } from "ai";
import type { ChatMode, SubscriptionTier } from "@/types";

type StreamWriter = {
  write: (data: any) => void;
};

// Upload status notifications
export const writeUploadStartStatus = (writer: StreamWriter): void => {
  writer.write({
    type: "data-upload-status",
    data: {
      message: "Uploading attachments to the computer",
      isUploading: true,
    },
    transient: true,
  });
};

export const writeUploadCompleteStatus = (writer: StreamWriter): void => {
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
export const writeSummarizationStarted = (writer: StreamWriter): void => {
  writer.write({
    type: "data-summarization",
    id: "summarization-status",
    data: {
      status: "started",
      message: "Summarizing chat context",
    },
  });
};

export const writeSummarizationCompleted = (writer: StreamWriter): void => {
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
    };

// Unified rate limit warning notification
export const writeRateLimitWarning = (
  writer: StreamWriter,
  data: RateLimitWarningData,
): void => {
  writer.write({
    type: "data-rate-limit-warning",
    data,
    transient: true,
  });
};
