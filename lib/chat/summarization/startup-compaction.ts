import { getPostHogFeatureFlagVariantForUser } from "@/lib/posthog/server";

export const STARTUP_COMPACTION_FLAG = "agent_startup_compaction_v1";
export const STARTUP_COMPACTION_PRIMARY_TIMEOUT_MS = 30_000;
export const STARTUP_COMPACTION_FALLBACK_MODEL = "model-deepseek-v4-flash-0731";

export type StartupCompactionVariant = "control" | "bounded_glm_v1";
export type StartupCompactionAttempt = {
  variant: StartupCompactionVariant;
  fallbackUsed: boolean;
};
export type StartupCompactionContext = {
  userId: string;
  onAttempt?: (attempt: StartupCompactionAttempt) => void;
};

export async function getStartupCompactionVariant(
  userId: string,
): Promise<StartupCompactionVariant> {
  if (!userId) return "control";
  const variant = await getPostHogFeatureFlagVariantForUser(
    STARTUP_COMPACTION_FLAG,
    userId,
    { sendFeatureFlagEvents: false },
  );
  return variant === "bounded_glm_v1" ? variant : "control";
}

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
