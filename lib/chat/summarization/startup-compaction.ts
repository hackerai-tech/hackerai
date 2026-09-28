export const STARTUP_COMPACTION_VARIANT =
  "glm53_flash_deepseek_v41_glm53_v1" as const;
export const STARTUP_COMPACTION_FALLBACK_MODELS = [
  "model-deepseek-v4-flash-vision-pro",
  "model-glm-5.3",
] as const;

export type StartupCompactionVariant = typeof STARTUP_COMPACTION_VARIANT;
export type StartupCompactionAttempt = {
  variant: StartupCompactionVariant;
  fallbackUsed: boolean;
};
export type StartupCompactionContext = {
  onAttempt?: (attempt: StartupCompactionAttempt) => void;
};

export class InvalidCompactionSummaryError extends Error {
  constructor() {
    super("Compaction returned an empty or incomplete summary");
    this.name = "InvalidCompactionSummaryError";
  }
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
