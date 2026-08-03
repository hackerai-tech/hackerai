import {
  SUBAGENT_MAX_RESULT_RECOVERIES,
  SUBAGENT_MAX_TRANSIENT_RETRIES,
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

export const isTransientProviderCategory = (
  category: ProviderErrorCategory,
): boolean => TRANSIENT_PROVIDER_CATEGORIES.has(category);

export type SubagentProviderRetryDecision = {
  category: ProviderErrorCategory;
  shouldRetry: boolean;
  delayMs: number;
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
    retriesUsed < SUBAGENT_MAX_TRANSIENT_RETRIES &&
    isTransientProviderCategory(category);

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

export const buildMissingSubagentResultRecoveryMessage = (): string =>
  "You ended the validation without submitting its structured result. Do not repeat completed checks. Use the evidence already gathered, resolve any remaining uncertainty briefly, and call submit_validation_result exactly once. Do not answer with a prose-only conclusion.";

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
