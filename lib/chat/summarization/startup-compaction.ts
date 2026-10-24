export const STARTUP_COMPACTION_VARIANT =
  "glm53_flash_deepseek_v41_glm53_v1" as const;
export const STARTUP_COMPACTION_FALLBACK_MODELS = [
  "model-deepseek-v4-flash-vision-pro",
  "model-glm-5.3",
] as const;

export type StartupCompactionVariant =
  | typeof STARTUP_COMPACTION_VARIANT
  | "abliteration_glm53_fallback_v1"
  | "moderation_glm53_abliteration_recovery_v2"
  | "max_large_v2_context_v1"
  | "pro_large_v2_context_v1";
export type StartupCompactionAttempt = {
  variant: StartupCompactionVariant;
  fallbackUsed: boolean;
};
export type StartupCompactionContext = {
  onAttempt?: (attempt: StartupCompactionAttempt) => void;
};

export class InvalidCompactionSummaryError extends Error {
  constructor(
    readonly reason:
      | "empty_summary"
      | "reasoning_only"
      | "non_stop_finish"
      | "missing_sections"
      | "invalid_summary" = "invalid_summary",
  ) {
    super("Compaction returned an empty or incomplete summary");
    this.name = "InvalidCompactionSummaryError";
  }
}

/** SDK total deadlines can be nested in a retry or API error. */
export function isCompactionTimeout(error: unknown, depth = 0): boolean {
  if (depth > 5 || typeof error !== "object" || error === null) return false;
  const value = error as { name?: string; cause?: unknown; errors?: unknown[] };
  return (
    value.name === "TimeoutError" ||
    isCompactionTimeout(value.cause, depth + 1) ||
    (Array.isArray(value.errors) &&
      value.errors.some((nested) => isCompactionTimeout(nested, depth + 1)))
  );
}

/** Only retry transient failures; caller cancellation is checked separately. */
export function isRecoverableStartupCompactionError(
  error: unknown,
  depth = 0,
): boolean {
  if (depth > 5 || typeof error !== "object" || error === null) return false;
  const value = error as {
    name?: string;
    isRetryable?: boolean;
    statusCode?: number;
    cause?: unknown;
    errors?: unknown[];
  };
  return (
    value.name === "TimeoutError" ||
    value.name === "InvalidCompactionSummaryError" ||
    value.isRetryable === true ||
    value.statusCode === 408 ||
    value.statusCode === 429 ||
    (typeof value.statusCode === "number" && value.statusCode >= 500) ||
    isRecoverableStartupCompactionError(value.cause, depth + 1) ||
    (Array.isArray(value.errors) &&
      value.errors.some((nested) =>
        isRecoverableStartupCompactionError(nested, depth + 1),
      ))
  );
}
