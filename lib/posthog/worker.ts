import { phLogger } from "@/lib/posthog/server";
import { classifyE2BError } from "@/lib/ai/tools/utils/e2b-errors";

/**
 * Creates a logger function matching the retry-with-backoff callback signature.
 * Sends events to PostHog when configured, otherwise falls back to console.
 *
 * @param source - Optional label for the log source (e.g., "sandbox-health", "retry-with-backoff")
 */
export function createRetryLogger(
  source?: string,
): (message: string, error?: unknown) => void {
  return (message: string, error?: unknown) => {
    const fields: Record<string, unknown> = {
      runtime: typeof process !== "undefined" ? "node" : "unknown",
    };
    if (source) fields.source = source;

    if (error !== undefined) {
      fields.errorMessage =
        error instanceof Error ? error.message : String(error);
      if (error instanceof Error && error.stack)
        fields.errorStack = error.stack;
      const category = classifyE2BError(error);
      if (category !== "unknown") {
        fields.e2bErrorCategory = category;
        fields.e2bErrorType =
          error instanceof Error ? error.constructor.name : "unknown";
      }
      if (error instanceof Error) {
        fields.error = error;
      }
    }

    phLogger.warn(message, fields);
  };
}
