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
    TRANSIENT_PROVIDER_CATEGORIES.has(category);

  return {
    category,
    shouldRetry,
    delayMs: shouldRetry ? 750 * 2 ** retriesUsed : 0,
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
