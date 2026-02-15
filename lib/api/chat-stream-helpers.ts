/**
 * Chat Stream Helpers
 *
 * Utility functions extracted from chat-handler to keep it clean and focused.
 */

import type { LanguageModel, UIMessage, UIMessageStreamWriter } from "ai";
import type { ChatMode, SubscriptionTier, Todo } from "@/types";
import type { ContextUsageData } from "@/app/components/ContextUsageIndicator";
import type { Id } from "@/convex/_generated/dataModel";
import { writeRateLimitWarning } from "@/lib/utils/stream-writer-utils";
import { countMessagesTokens } from "@/lib/token-utils";
import {
  checkAndSummarizeIfNeeded,
  type EnsureSandbox,
} from "@/lib/chat/summarization";

/**
 * Check if messages contain file attachments
 */
export function hasFileAttachments(
  messages: Array<{ parts?: Array<{ type?: string }> }>,
): boolean {
  return messages.some((msg) =>
    msg.parts?.some((part) => part.type === "file"),
  );
}

/**
 * Count total file attachments and how many are images
 */
export function countFileAttachments(
  messages: Array<{ parts?: Array<{ type?: string; mediaType?: string }> }>,
): { totalFiles: number; imageCount: number } {
  let totalFiles = 0;
  let imageCount = 0;

  for (const msg of messages) {
    if (!msg.parts) continue;
    for (const part of msg.parts) {
      if (part.type !== "file") continue;
      totalFiles++;
      if ((part.mediaType ?? "").startsWith("image/")) {
        imageCount++;
      }
    }
  }

  return { totalFiles, imageCount };
}

/**
 * Send rate limit warnings based on subscription and rate limit info
 */
export function sendRateLimitWarnings(
  writer: UIMessageStreamWriter,
  options: {
    subscription: SubscriptionTier;
    mode: ChatMode;
    rateLimitInfo: {
      remaining: number;
      resetTime: Date;
      session?: { remaining: number; limit: number; resetTime: Date };
      weekly?: { remaining: number; limit: number; resetTime: Date };
      extraUsagePointsDeducted?: number;
    };
  },
): void {
  const { subscription, mode, rateLimitInfo } = options;

  if (subscription === "free") {
    // Free users: sliding window (remaining count)
    if (rateLimitInfo.remaining <= 5) {
      writeRateLimitWarning(writer, {
        warningType: "sliding-window",
        remaining: rateLimitInfo.remaining,
        resetTime: rateLimitInfo.resetTime.toISOString(),
        mode,
        subscription,
      });
    }
  } else if (rateLimitInfo.session && rateLimitInfo.weekly) {
    // Paid users with extra usage: warn when extra usage is being used
    if (
      rateLimitInfo.extraUsagePointsDeducted &&
      rateLimitInfo.extraUsagePointsDeducted > 0
    ) {
      const bucketType =
        rateLimitInfo.session.remaining <= rateLimitInfo.weekly.remaining
          ? "session"
          : "weekly";
      const resetTime =
        bucketType === "session"
          ? rateLimitInfo.session.resetTime
          : rateLimitInfo.weekly.resetTime;

      writeRateLimitWarning(writer, {
        warningType: "extra-usage-active",
        bucketType,
        resetTime: resetTime.toISOString(),
        subscription,
      });
    } else {
      // Paid users without extra usage: token bucket (remaining percentage at 10%)
      const sessionPercent =
        (rateLimitInfo.session.remaining / rateLimitInfo.session.limit) * 100;
      const weeklyPercent =
        (rateLimitInfo.weekly.remaining / rateLimitInfo.weekly.limit) * 100;

      if (sessionPercent <= 10) {
        writeRateLimitWarning(writer, {
          warningType: "token-bucket",
          bucketType: "session",
          remainingPercent: Math.round(sessionPercent),
          resetTime: rateLimitInfo.session.resetTime.toISOString(),
          subscription,
        });
      }

      if (weeklyPercent <= 10) {
        writeRateLimitWarning(writer, {
          warningType: "token-bucket",
          bucketType: "weekly",
          remainingPercent: Math.round(weeklyPercent),
          resetTime: rateLimitInfo.weekly.resetTime.toISOString(),
          subscription,
        });
      }
    }
  }
}

/**
 * Check if an error is an xAI safety check error (403 from api.x.ai)
 * These are false positives that should be suppressed from logging
 */
export function isXaiSafetyError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  // Handle both direct errors (from generateText) and wrapped errors (from streamText onError)
  const apiError =
    "error" in error && error.error instanceof Error
      ? (error.error as Error & {
          statusCode?: number;
          url?: string;
          responseBody?: string;
        })
      : (error as Error & {
          statusCode?: number;
          url?: string;
          responseBody?: string;
        });

  return (
    apiError.statusCode === 403 &&
    typeof apiError.url === "string" &&
    apiError.url.includes("api.x.ai") &&
    typeof apiError.responseBody === "string"
  );
}

/**
 * Check if an error is a provider API error that should trigger fallback
 * Specifically targets Google/Gemini INVALID_ARGUMENT errors
 */
export function isProviderApiError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const err = error as {
    statusCode?: number;
    responseBody?: string;
    data?: {
      error?: {
        code?: number;
        message?: string;
        metadata?: { raw?: string; provider_name?: string };
      };
    };
  };

  // Must be a 400 error
  if (err.statusCode !== 400 && err.data?.error?.code !== 400) return false;

  // Check for INVALID_ARGUMENT in response body or nested metadata
  const responseBody = err.responseBody || "";
  const rawMetadata = err.data?.error?.metadata?.raw || "";
  const combined = responseBody + rawMetadata;

  return combined.includes("INVALID_ARGUMENT");
}

/**
 * Build provider options for streamText
 */
/**
 * Compute context usage breakdown from messages, separating summary from regular messages.
 */
export function computeContextUsage(
  messages: UIMessage[],
  fileTokens: Record<Id<"files">, number>,
  systemTokens: number,
  maxTokens: number,
): ContextUsageData {
  const summaryMsg = messages.find((m) =>
    m.parts?.some(
      (p: { type?: string; text?: string }) =>
        p.type === "text" &&
        typeof p.text === "string" &&
        p.text.includes("<context_summary>"),
    ),
  );
  const summaryTokens = summaryMsg
    ? countMessagesTokens([summaryMsg], fileTokens)
    : 0;
  const nonSummaryMessages = summaryMsg
    ? messages.filter((m) => m !== summaryMsg)
    : messages;
  const messagesTokens = countMessagesTokens(nonSummaryMessages, fileTokens);

  return { systemTokens, summaryTokens, messagesTokens, maxTokens };
}

export const contextUsageEnabled =
  process.env.NEXT_PUBLIC_ENABLE_CONTEXT_USAGE === "true";

/**
 * Write a context usage data stream part to the client.
 */
export function writeContextUsage(
  writer: UIMessageStreamWriter,
  usage: ContextUsageData,
): void {
  writer.write({ type: "data-context-usage", data: usage });
}

export interface SummarizationStepResult {
  needsSummarization: boolean;
  summarizedMessages?: UIMessage[];
  contextUsage?: ContextUsageData;
}

export async function runSummarizationStep(options: {
  messages: UIMessage[];
  subscription: SubscriptionTier;
  languageModel: LanguageModel;
  mode: ChatMode;
  writer: UIMessageStreamWriter;
  chatId: string | null;
  fileTokens: Record<Id<"files">, number>;
  todos: Todo[];
  abortSignal?: AbortSignal;
  ensureSandbox?: EnsureSandbox;
  systemPromptTokens: number;
  ctxSystemTokens: number;
  ctxMaxTokens: number;
}): Promise<SummarizationStepResult> {
  const { needsSummarization, summarizedMessages } =
    await checkAndSummarizeIfNeeded(
      options.messages,
      options.subscription,
      options.languageModel,
      options.mode,
      options.writer,
      options.chatId,
      options.fileTokens,
      options.todos,
      options.abortSignal,
      options.ensureSandbox,
      options.systemPromptTokens,
    );

  if (!needsSummarization) {
    return { needsSummarization: false };
  }

  const contextUsage = contextUsageEnabled
    ? computeContextUsage(
        summarizedMessages,
        options.fileTokens,
        options.ctxSystemTokens,
        options.ctxMaxTokens,
      )
    : undefined;

  if (contextUsage) {
    writeContextUsage(options.writer, contextUsage);
  }

  return { needsSummarization: true, summarizedMessages, contextUsage };
}

export function buildProviderOptions(
  isReasoningModel: boolean,
  subscription: SubscriptionTier,
) {
  return {
    xai: {
      // Disable storing the conversation in XAI's database
      store: false,
    },
    openrouter: {
      ...(isReasoningModel
        ? { reasoning: { enabled: true } }
        : { reasoning: { enabled: false } }),
      provider: {
        ...(subscription === "free" ? { sort: "price" } : { sort: "latency" }),
      },
    },
  } as const;
}
