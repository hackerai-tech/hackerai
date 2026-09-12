import "server-only";

import { UIMessagePart, UIMessageStreamWriter } from "ai";
import type { ChatMode, SubscriptionTier } from "@/types";
import type { LimitCapReason } from "@/lib/limit-pressure";
import type { AgentRunSpendCapBasis } from "@/lib/chat/agent-run-spend-cap";

// Upload status notifications
export const writeUploadStartStatus = (
  writer: UIMessageStreamWriter,
  message: string = "Uploading attachments to the computer",
): void => {
  writer.write({
    type: "data-upload-status",
    data: {
      message,
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
  compactionIndex?: number,
  progress?: { startedAt: number; message: string },
): void => {
  writer.write({
    type: "data-summarization",
    id: compactionIndex
      ? `summarization-status-${compactionIndex}`
      : "summarization-status",
    data: {
      status: "started",
      message: "Automatically compacting context",
      ...progress,
    },
    transient: true, // Don't persist started state - only show during processing
  });
};

/** Keep long waits visible without persisting heartbeats in conversation history. */
export const startSummarizationProgress = (
  writer: UIMessageStreamWriter,
  compactionIndex?: number,
  signal?: AbortSignal,
) => {
  const startedAt = Date.now();
  let retrying = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    stopped = true;
    clearInterval(timer);
    signal?.removeEventListener("abort", stop);
  };
  const emit = (message: string) => {
    if (stopped || signal?.aborted) return;
    writeSummarizationStarted(writer, compactionIndex, { startedAt, message });
  };
  emit("Preparing to continue…");
  if (!signal?.aborted) {
    timer = setInterval(() => {
      try {
        emit(
          retrying ? "Retrying preparation…" : "Still preparing to continue…",
        );
      } catch {
        // A disconnected writer must not create an uncaught timer exception.
        stop();
      }
    }, 15_000);
    timer.unref?.();
    signal?.addEventListener("abort", stop, { once: true });
  }
  return {
    stop,
    retry: () => {
      retrying = true;
      emit("Retrying preparation…");
    },
  };
};

export const writeSummarizationFailed = (
  writer: UIMessageStreamWriter,
  compactionIndex?: number,
): void => {
  writer.write({
    type: "data-summarization",
    id: compactionIndex
      ? `summarization-status-${compactionIndex}`
      : "summarization-status",
    data: {
      status: "failed",
      message:
        "Couldn’t summarize earlier messages. Your existing context is unchanged.",
    },
  });
};

export const writeSummarizationCompleted = (
  writer: UIMessageStreamWriter,
  compactionIndex?: number,
): void => {
  writer.write({
    type: "data-summarization",
    id: compactionIndex
      ? `summarization-status-${compactionIndex}`
      : "summarization-status",
    data: {
      status: "completed",
      message: "Context automatically compacted",
    },
  });
};

/** Clear the transient compacting indicator without persisting a success. */
export const writeSummarizationCleared = (
  writer: UIMessageStreamWriter,
  compactionIndex?: number,
): void => {
  writer.write({
    type: "data-summarization",
    id: compactionIndex
      ? `summarization-status-${compactionIndex}`
      : "summarization-status",
    data: { status: "completed", message: "" },
    transient: true,
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
    message: "Context automatically compacted",
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
      // Free users: sliding window (remaining request units)
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
      capReason?: LimitCapReason;
      // Mid-stream emits bypass localStorage dedup so threshold escalations
      // (75→90→100) within a single stream always reach the client.
      midStream?: boolean;
      // Set when the response was cut off mid-stream because the bucket hit 0.
      cutOff?: boolean;
    }
  | {
      // Paid users: extra usage is now being consumed
      warningType: "extra-usage-active";
      bucketType: "monthly";
      resetTime: string;
      subscription: SubscriptionTier;
      capReason?: LimitCapReason;
      midStream?: boolean;
    }
  | {
      // Paid users continuing on the daily free fallback allowance.
      warningType: "paid-daily-free-allowance";
      resetTime: string;
      subscription: SubscriptionTier;
      mode: ChatMode;
      costLimitDollars: number;
    }
  | {
      // Legacy Pro Agent per-run spend-cap warning.
      warningType: "agent-run-spend-cap";
      resetTime: string;
      subscription: "pro";
      mode: "agent";
      runCostDollars: number;
      runCapDollars: number;
      monthlyRemainingDollars: number;
      capBasis: AgentRunSpendCapBasis;
      premiumContinuationAllowed: boolean;
      midStream?: boolean;
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
