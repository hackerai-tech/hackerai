import { createRetryLogger } from "@/lib/axiom/worker";

/** Logger used for retry/abort events; safe in Trigger.dev (no @axiomhq/nextjs). */
const retryLogger = createRetryLogger("retry-with-backoff");

/**
 * Retry configuration options
 */
export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Base delay in milliseconds (default: 400ms) */
  baseDelayMs?: number;
  /** Jitter range in milliseconds (default: ±40ms) */
  jitterMs?: number;
  /** Function to determine if error is permanent (no retry) */
  isPermanentError?: (error: unknown) => boolean;
  /** Optional logger function */
  logger?: (message: string, error?: unknown) => void;
  /** Optional abort signal to cancel retries */
  signal?: AbortSignal;
}

/**
 * Default function to check if error is permanent (sandbox terminated)
 */
function defaultIsPermanentError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  return (
    error.name === "NotFoundError" ||
    error.message.includes("not running anymore") ||
    error.message.includes("Sandbox not found")
  );
}

/**
 * Retries an async operation with exponential backoff and jitter.
 *
 * Features:
 * - Exponential backoff with configurable base delay
 * - Random jitter to prevent thundering herd
 * - Permanent error detection (fails fast)
 * - Configurable retry count
 *
 * @param operation - Async function to retry
 * @param options - Retry configuration
 * @returns Promise with operation result
 * @throws Last error if all retries exhausted or permanent error encountered
 *
 * @example
 * ```ts
 * const result = await retryWithBackoff(
 *   () => sandbox.commands.run("ls"),
 *   { maxRetries: 3, baseDelayMs: 400 }
 * );
 * ```
 */
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 400,
    jitterMs = 40,
    isPermanentError = defaultIsPermanentError,
    logger = retryLogger,
    signal,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Check if aborted before each attempt
    if (signal?.aborted) {
      retryLogger(
        `Retry aborted before attempt ${attempt + 1}/${maxRetries} (reason: signal_already_aborted)`,
      );
      throw new DOMException("Operation aborted", "AbortError");
    }

    try {
      return await operation();
    } catch (error) {
      lastError = error;

      // Check if this is a permanent error (sandbox terminated/not found)
      if (isPermanentError(error)) {
        logger(
          "Permanent error detected, not retrying:",
          error instanceof Error ? error.message : error,
        );
        throw error;
      }

      // If this is the last attempt, give up
      if (attempt === maxRetries - 1) {
        logger(
          `Operation failed after ${maxRetries} attempts:`,
          error instanceof Error ? error.message : error,
        );
        throw error;
      }

      // Calculate exponential backoff with jitter
      const baseDelay = baseDelayMs * Math.pow(2, attempt);
      const jitter = Math.random() * (jitterMs * 2) - jitterMs;
      const delayMs = Math.max(0, baseDelay + jitter);

      logger(
        `Attempt ${attempt + 1}/${maxRetries} failed (transient error), retrying in ${Math.round(delayMs)}ms:`,
        error instanceof Error ? error.message : error,
      );

      // Wait before retrying (abort-aware)
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(resolve, delayMs);
        if (signal) {
          const onAbort = () => {
            clearTimeout(timeout);
            retryLogger(
              `Retry aborted during backoff delay (attempt ${attempt + 1}/${maxRetries}, delayMs: ${delayMs}, reason: signal_aborted_during_delay)`,
            );
            reject(new DOMException("Operation aborted", "AbortError"));
          };
          signal.addEventListener("abort", onAbort, { once: true });
          // Clean up listener if timeout completes normally
          setTimeout(
            () => signal.removeEventListener("abort", onAbort),
            delayMs + 1,
          );
        }
      });
    }
  }

  // This should never be reached, but TypeScript needs it
  throw lastError;
}
