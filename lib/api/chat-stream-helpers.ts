/**
 * Chat Stream Helpers
 *
 * Utility functions extracted from chat-handler to keep it clean and focused.
 */

import type { UIMessageStreamWriter } from "ai";
import type { SandboxPreference, ChatMode, SubscriptionTier } from "@/types";
import { writeRateLimitWarning } from "@/lib/utils/stream-writer-utils";

// Tools that interact with the sandbox environment
const SANDBOX_ENVIRONMENT_TOOLS = [
  "shell",
  "run_terminal_cmd",
  "get_terminal_files",
  "match",
  "file",
] as const;

/**
 * Determine the sandbox type for a tool call
 */
export function getSandboxTypeForTool(
  toolName: string,
  sandboxPreference?: SandboxPreference,
): string | undefined {
  if (!SANDBOX_ENVIRONMENT_TOOLS.includes(toolName as any)) {
    return undefined;
  }
  return sandboxPreference && sandboxPreference !== "e2b" ? "local" : "e2b";
}

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
