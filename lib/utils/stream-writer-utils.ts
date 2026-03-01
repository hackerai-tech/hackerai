import "server-only";

import { UIMessagePart, UIMessageStreamWriter } from "ai";
import type { ModelMessage } from "ai";
import type { ChatMode, SubscriptionTier } from "@/types";

function countMessageChars(messages: ModelMessage[]): number {
  let total = 0;
  for (const m of messages) {
    if (typeof m.content === "string") {
      total += m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p !== null && typeof p === "object" && "text" in p) {
          total += ((p as { text: string }).text ?? "").length;
        }
      }
    }
  }
  return total;
}

export function logPrepareStepMessages(
  step: number,
  phase: "input" | "output",
  messages: ModelMessage[],
): void {
  const lines: string[] = [];
  let totalChars = 0;
  for (const m of messages) {
    const msgChars = countMessageChars([m]);
    totalChars += msgChars;
    const tokens = Math.round(msgChars / 4);
    const text =
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content
              .map((p) =>
                "text" in p
                  ? (p as { text: string }).text
                  : "type" in p
                    ? `[${(p as { type: string }).type}]`
                    : "[part]",
              )
              .join(" ")
          : "[non-text]";
    const truncated = text.length > 50 ? `${text.slice(0, 50)}...` : text;
    lines.push(`  ${m.role} (${msgChars}c ~${tokens}t): ${truncated}`);
  }
  const totalTokens = Math.round(totalChars / 4);
  if (process.env.DEBUG_PREPARE_STEP) {
    console.log(
      `[prepareStep] step=${step} ${phase} msgs=${messages.length} total=${totalChars}c ~${totalTokens}t\n${lines.join("\n")}`,
    );
  }
}

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
