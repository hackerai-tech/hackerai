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
  errorName: string;
  errorCode?: string;
  statusCode?: number;
};

export type SubagentResultRecoveryRetryDecision =
  SubagentRecoveryErrorDiagnostics & {
    shouldRetry: boolean;
    delayMs: number;
  };

const safeDiagnosticToken = (value: unknown): string | undefined => {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const token = String(value);
  return /^[A-Za-z0-9_.:-]{1,120}$/.test(token) ? token : undefined;
};

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
  const errorCode = safeDiagnosticToken(details.errorCode);

  return {
    category: getProviderErrorCategory(details),
    errorName: safeDiagnosticToken(details.errorName) ?? "UnknownError",
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
