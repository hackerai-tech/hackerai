import {
  SUBAGENT_MAX_RESULT_RECOVERIES,
  SUBAGENT_MAX_RESULT_RECOVERY_FAILURE_RETRIES,
  SUBAGENT_MAX_PROVIDER_RECOVERY_RETRIES,
} from "./contracts";
import {
  extractErrorDetails,
  getProviderErrorCategory,
  type ProviderErrorCategory,
} from "@/lib/utils/error-utils";

const TRANSIENT_PROVIDER_CATEGORIES = new Set<ProviderErrorCategory>([
  "rate_limited",
  "provider_5xx",
  "stream_terminated",
  "timeout",
]);

const RECOVERABLE_PROVIDER_CATEGORIES = new Set<ProviderErrorCategory>([
  ...TRANSIENT_PROVIDER_CATEGORIES,
  "content_blocked",
]);

export const isTransientProviderCategory = (
  category: ProviderErrorCategory,
): boolean => TRANSIENT_PROVIDER_CATEGORIES.has(category);

export const isRecoverableProviderCategory = (
  category: ProviderErrorCategory,
): boolean => RECOVERABLE_PROVIDER_CATEGORIES.has(category);

export type SubagentProviderRetryDecision = {
  category: ProviderErrorCategory;
  shouldRetry: boolean;
  delayMs: number;
};

export type SubagentRecoveryErrorDiagnostics = {
  category: ProviderErrorCategory;
  errorName?: string;
  errorCode?: string;
  statusCode?: number;
};

export type SubagentResultRecoveryRetryDecision =
  SubagentRecoveryErrorDiagnostics & {
    shouldRetry: boolean;
    delayMs: number;
  };

// Keep enough of the global step budget for one structured-output attempt and
// its single bounded retry. Without this reserve, an exploratory generation can
// consume all 50 steps and make the existing result-recovery path unreachable.
export const SUBAGENT_RESULT_RECOVERY_STEP_RESERVE =
  1 + SUBAGENT_MAX_RESULT_RECOVERY_FAILURE_RETRIES;

// Count every structured-output generation, including generations that defer
// because a parent update arrived. This prevents deferrals from bypassing the
// same bounded recovery budget used for provider and schema failures.
export const canStartSubagentResultRecoveryGeneration = (
  generationAttemptsUsed: number,
): boolean => generationAttemptsUsed < SUBAGENT_RESULT_RECOVERY_STEP_RESERVE;

export const getSubagentExplorationStepLimit = (
  remainingSteps: number,
): number =>
  Math.max(1, remainingSteps - SUBAGENT_RESULT_RECOVERY_STEP_RESERVE);

export const shouldStartSubagentResultRecovery = (
  recoveriesUsed: number,
  options: {
    aborted: boolean;
    spendCapExceeded: boolean;
    remainingSteps: number;
  },
): boolean =>
  options.remainingSteps <= SUBAGENT_RESULT_RECOVERY_STEP_RESERVE &&
  canRecoverMissingSubagentResult(recoveriesUsed, {
    aborted: options.aborted,
    spendCapExceeded: options.spendCapExceeded,
    hasStepsRemaining: options.remainingSteps > 0,
  });

const ALLOWED_RECOVERY_ERROR_NAMES = new Set([
  "AI_APICallError",
  "AI_JSONParseError",
  "AI_NoObjectGeneratedError",
  "AI_NoOutputGeneratedError",
  "AI_RetryError",
  "AI_TypeValidationError",
  "AbortError",
  "TimeoutError",
]);

const ALLOWED_RECOVERY_ERROR_CODES = new Set([
  "AI_APICallError",
  "AI_JSONParseError",
  "AI_NoObjectGeneratedError",
  "AI_NoOutputGeneratedError",
  "AI_RetryError",
  "AI_TypeValidationError",
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const allowlistedDiagnostic = (
  value: unknown,
  allowedValues: ReadonlySet<string>,
): string | undefined =>
  typeof value === "string" && allowedValues.has(value) ? value : undefined;

export const getSubagentRecoveryErrorDiagnostics = (
  error: unknown,
): SubagentRecoveryErrorDiagnostics => {
  const details = extractErrorDetails(error);
  const statusCode =
    typeof details.statusCode === "number" &&
    Number.isInteger(details.statusCode) &&
    details.statusCode >= 400 &&
    details.statusCode <= 599
      ? details.statusCode
      : undefined;
  const errorName = allowlistedDiagnostic(
    details.errorName,
    ALLOWED_RECOVERY_ERROR_NAMES,
  );
  const errorCode = allowlistedDiagnostic(
    details.errorCode,
    ALLOWED_RECOVERY_ERROR_CODES,
  );

  return {
    category: getProviderErrorCategory(details),
    ...(errorName ? { errorName } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(statusCode == null ? {} : { statusCode }),
  };
};

export const getSubagentResultRecoveryRetryDecision = (
  error: unknown,
  retriesUsed: number,
  options: {
    aborted: boolean;
    spendCapExceeded: boolean;
    hasStepsRemaining: boolean;
  },
): SubagentResultRecoveryRetryDecision => {
  const diagnostics = getSubagentRecoveryErrorDiagnostics(error);
  const shouldRetry =
    !options.aborted &&
    !options.spendCapExceeded &&
    options.hasStepsRemaining &&
    retriesUsed < SUBAGENT_MAX_RESULT_RECOVERY_FAILURE_RETRIES;

  return {
    ...diagnostics,
    shouldRetry,
    delayMs: shouldRetry ? 750 : 0,
  };
};

export const getSubagentProviderRetryDecision = (
  error: unknown,
  retriesUsed: number,
  options: {
    aborted: boolean;
    spendCapExceeded: boolean;
    hasStepsRemaining: boolean;
  },
): SubagentProviderRetryDecision => {
  const category = getProviderErrorCategory(extractErrorDetails(error));
  const shouldRetry =
    !options.aborted &&
    !options.spendCapExceeded &&
    options.hasStepsRemaining &&
    retriesUsed < SUBAGENT_MAX_PROVIDER_RECOVERY_RETRIES &&
    isRecoverableProviderCategory(category);

  const baseDelayMs = 750 * 2 ** retriesUsed;

  return {
    category,
    shouldRetry,
    delayMs: shouldRetry
      ? Math.round(baseDelayMs * (1 + Math.random() * 0.25))
      : 0,
  };
};

export const canRecoverMissingSubagentResult = (
  recoveriesUsed: number,
  options: {
    aborted: boolean;
    spendCapExceeded: boolean;
    hasStepsRemaining: boolean;
  },
): boolean =>
  !options.aborted &&
  !options.spendCapExceeded &&
  options.hasStepsRemaining &&
  recoveriesUsed < SUBAGENT_MAX_RESULT_RECOVERIES;

export const buildMissingSubagentResultRecoveryMessage = (
  finalResultToolName = "submit_validation_result",
): string =>
  finalResultToolName === "submit_validation_result"
    ? "You ended the validation without submitting its structured result. Do not repeat completed checks. Use the evidence already gathered, resolve any remaining uncertainty briefly, and call submit_validation_result exactly once. A confirmed result must include at least one reproduction step and one evidence reference. Do not answer with a prose-only conclusion."
    : `You ended the task without submitting its structured result. Do not repeat completed work. Use the evidence already gathered, state any limitations, and call ${finalResultToolName} exactly once. Do not answer with a prose-only conclusion.`;

export const pipeSubagentUiMessageStream = async <T>(
  stream: ReadableStream<T>,
  write: (chunk: T) => void,
): Promise<void> => {
  const reader = stream.getReader();
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        return;
      }
      write(value);
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
};
