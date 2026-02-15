import type { RateLimitWarningData } from "@/app/components/RateLimitWarning";
import { isChatMode, isSubscriptionTier } from "@/types/chat";

const WARNING_TYPES = [
  "sliding-window",
  "token-bucket",
  "extra-usage-active",
] as const;
type RawWarningType = (typeof WARNING_TYPES)[number];

const BUCKET_TYPES = ["session", "weekly"] as const;
type RawBucketType = (typeof BUCKET_TYPES)[number];

function isString(v: unknown): v is string {
  return typeof v === "string";
}
function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export interface ParseRateLimitWarningOptions {
  /** When true, the function returns null (caller should not show the warning). */
  hasUserDismissed: boolean;
}

const EXTRA_USAGE_STORAGE_KEY_PREFIX = "extraUsageWarningShownUntil_";

/**
 * Parses raw stream/event data for a rate-limit warning into a typed
 * RateLimitWarningData object. Performs extra-usage-active localStorage
 * deduplication so that warning is shown at most once per reset period.
 * Returns null if the user has dismissed the warning, data is invalid,
 * or (for extra-usage-active) the warning was already shown for this period.
 */
export function parseRateLimitWarning(
  rawData: Record<string, unknown> | null | undefined,
  options: ParseRateLimitWarningOptions,
): RateLimitWarningData | null {
  const { hasUserDismissed } = options;
  if (hasUserDismissed || !rawData || typeof rawData !== "object") {
    return null;
  }

  const warningType = rawData.warningType as RawWarningType | undefined;
  if (!warningType || !WARNING_TYPES.includes(warningType)) {
    return null;
  }

  const resetTimeRaw = rawData.resetTime;
  if (!isString(resetTimeRaw)) {
    return null;
  }
  const resetTime = new Date(resetTimeRaw);
  if (isNaN(resetTime.getTime())) {
    return null;
  }

  if (!isSubscriptionTier(rawData.subscription)) {
    return null;
  }
  const subscription = rawData.subscription;

  if (warningType === "sliding-window") {
    const remaining = rawData.remaining;
    const modeRaw = typeof rawData.mode === "string" ? rawData.mode : null;
    if (!isNumber(remaining) || remaining < 0 || !isChatMode(modeRaw)) {
      return null;
    }
    return {
      warningType: "sliding-window",
      remaining,
      resetTime,
      mode: modeRaw,
      subscription,
    };
  }

  if (warningType === "extra-usage-active") {
    const bucketType = rawData.bucketType as RawBucketType | undefined;
    if (!bucketType || !BUCKET_TYPES.includes(bucketType)) {
      return null;
    }
    if (typeof window === "undefined" || !window.localStorage) {
      return {
        warningType: "extra-usage-active",
        bucketType,
        resetTime,
        subscription,
      };
    }
    const storageKey = `${EXTRA_USAGE_STORAGE_KEY_PREFIX}${bucketType}`;
    const storedResetTime = localStorage.getItem(storageKey);
    if (storedResetTime && new Date(storedResetTime) >= new Date()) {
      return null;
    }
    localStorage.setItem(storageKey, resetTimeRaw);
    return {
      warningType: "extra-usage-active",
      bucketType,
      resetTime,
      subscription,
    };
  }

  // token-bucket
  const bucketType = rawData.bucketType as RawBucketType | undefined;
  const remainingPercent = rawData.remainingPercent;
  if (
    !bucketType ||
    !BUCKET_TYPES.includes(bucketType) ||
    !isNumber(remainingPercent) ||
    remainingPercent < 0 ||
    remainingPercent > 100
  ) {
    return null;
  }
  return {
    warningType: "token-bucket",
    bucketType,
    remainingPercent,
    resetTime,
    subscription,
  };
}
