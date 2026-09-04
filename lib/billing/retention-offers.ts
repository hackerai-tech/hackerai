import type Stripe from "stripe";

import type { CancellationReasonCategory } from "@/lib/billing/cancellation-reasons";
import type { SubscriptionTier } from "@/types";

/**
 * Retention offers shown inside the in-app cancellation flow.
 *
 * - "pause": the plan ends at the paid-through date and is re-created
 *   automatically (same price, saved card) after the chosen number of months.
 * - "discount": a repeating Stripe coupon applied to the next monthly renewals.
 *
 * Eligibility is deliberately conservative and reason-aware so the offers are
 * shown to people whose stated reason the offer can actually address.
 */
export const RETENTION_OFFERS_FLAG_KEY = "hac-retention-offers-v1";

export type RetentionOfferType = "pause" | "discount";

export const PAUSE_DURATION_MONTH_OPTIONS = [1, 2, 3] as const;
export type PauseDurationMonths = (typeof PAUSE_DURATION_MONTH_OPTIONS)[number];

/** Minimum gap between two pauses for the same user. */
export const PAUSE_COOLDOWN_DAYS = 180;

/** Automatic resume retries before the pause is marked as failed. */
export const PAUSE_RESUME_MAX_ATTEMPTS = 3;
/** Delay between automatic resume retries after a retryable payment failure. */
export const PAUSE_RESUME_RETRY_DELAY_MS = 24 * 60 * 60 * 1000;

export const RETENTION_DISCOUNT = {
  percentOff: 50,
  durationMonths: 2,
  /** Deterministic Stripe coupon id so the coupon is created at most once. */
  couponId: "hackerai-retention-50-off-2-months",
  couponName: "HackerAI retention: 50% off for 2 months",
} as const;

const PAUSE_ELIGIBLE_TIERS: ReadonlySet<SubscriptionTier> = new Set([
  "pro",
  "pro-plus",
  "ultra",
]);

/**
 * Higher-priced individual tiers only. Pro stays discount-free so the offer
 * cannot contaminate the HAC-46 Pro monthly pricing experiment.
 */
const DISCOUNT_ELIGIBLE_TIERS: ReadonlySet<SubscriptionTier> = new Set([
  "pro-plus",
  "ultra",
]);

const PAUSE_REASONS: ReadonlySet<CancellationReasonCategory> = new Set([
  "too_expensive",
  "not_using_enough",
  "temporary_pause",
  "hit_usage_limits",
  "other",
]);

const DISCOUNT_REASONS: ReadonlySet<CancellationReasonCategory> = new Set([
  "too_expensive",
  "not_using_enough",
  "hit_usage_limits",
  "other",
]);

export const SUBSCRIPTION_PAUSE_METADATA = {
  pauseId: "hackeraiPauseId",
  months: "hackeraiPauseMonths",
  resumeAt: "hackeraiPauseResumeAt",
  requestedAt: "hackeraiPauseRequestedAt",
} as const;

export const RETENTION_DISCOUNT_METADATA = {
  couponId: "hackeraiRetentionDiscountCouponId",
  percentOff: "hackeraiRetentionDiscountPercentOff",
  durationMonths: "hackeraiRetentionDiscountDurationMonths",
  appliedAt: "hackeraiRetentionDiscountAppliedAt",
} as const;

export const PAUSE_RESUME_CHECKOUT_TYPE = "pause_resume";

export type RetentionOfferIneligibilityReason =
  | "offers_disabled"
  | "unsupported_tier"
  | "unsupported_billing_interval"
  | "subscription_not_active"
  | "cancellation_already_scheduled"
  | "reason_not_applicable"
  | "multi_seat"
  | "pause_cooldown"
  | "discount_already_applied"
  | "missing_period_end";

export type RetentionOfferEligibilityInput = {
  offersEnabled: boolean;
  tier: SubscriptionTier | undefined;
  billingInterval: string | undefined;
  billingIntervalCount?: number | null;
  subscriptionStatus: Stripe.Subscription.Status | string;
  cancelAtPeriodEnd: boolean;
  quantity?: number | null;
  reasonCategory: CancellationReasonCategory;
  currentPeriodEndMs: number | undefined;
  hasExistingDiscount: boolean;
  retentionDiscountAlreadyApplied: boolean;
  lastPauseRequestedAtMs: number | undefined;
  nowMs?: number;
};

export type RetentionOfferEligibility = {
  pause:
    | { eligible: true }
    | { eligible: false; reason: RetentionOfferIneligibilityReason };
  discount:
    | { eligible: true }
    | { eligible: false; reason: RetentionOfferIneligibilityReason };
};

function sharedIneligibility(
  input: RetentionOfferEligibilityInput,
): RetentionOfferIneligibilityReason | null {
  if (!input.offersEnabled) return "offers_disabled";
  if (
    input.subscriptionStatus !== "active" &&
    input.subscriptionStatus !== "trialing"
  ) {
    return "subscription_not_active";
  }
  if (input.cancelAtPeriodEnd) return "cancellation_already_scheduled";
  if (
    input.billingInterval !== "month" ||
    (input.billingIntervalCount ?? 1) !== 1
  ) {
    return "unsupported_billing_interval";
  }
  if ((input.quantity ?? 1) !== 1) return "multi_seat";
  return null;
}

export function evaluateRetentionOfferEligibility(
  input: RetentionOfferEligibilityInput,
): RetentionOfferEligibility {
  const shared = sharedIneligibility(input);
  if (shared) {
    return {
      pause: { eligible: false, reason: shared },
      discount: { eligible: false, reason: shared },
    };
  }

  const nowMs = input.nowMs ?? Date.now();

  let pause: RetentionOfferEligibility["pause"];
  if (!input.tier || !PAUSE_ELIGIBLE_TIERS.has(input.tier)) {
    pause = { eligible: false, reason: "unsupported_tier" };
  } else if (!PAUSE_REASONS.has(input.reasonCategory)) {
    pause = { eligible: false, reason: "reason_not_applicable" };
  } else if (!input.currentPeriodEndMs) {
    pause = { eligible: false, reason: "missing_period_end" };
  } else if (
    input.lastPauseRequestedAtMs !== undefined &&
    nowMs - input.lastPauseRequestedAtMs <
      PAUSE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000
  ) {
    pause = { eligible: false, reason: "pause_cooldown" };
  } else {
    pause = { eligible: true };
  }

  let discount: RetentionOfferEligibility["discount"];
  if (!input.tier || !DISCOUNT_ELIGIBLE_TIERS.has(input.tier)) {
    discount = { eligible: false, reason: "unsupported_tier" };
  } else if (!DISCOUNT_REASONS.has(input.reasonCategory)) {
    discount = { eligible: false, reason: "reason_not_applicable" };
  } else if (
    input.hasExistingDiscount ||
    input.retentionDiscountAlreadyApplied
  ) {
    discount = { eligible: false, reason: "discount_already_applied" };
  } else {
    discount = { eligible: true };
  }

  return { pause, discount };
}

export function isPauseDurationMonths(
  value: unknown,
): value is PauseDurationMonths {
  return (
    typeof value === "number" &&
    (PAUSE_DURATION_MONTH_OPTIONS as readonly number[]).includes(value)
  );
}

/**
 * Add calendar months in UTC, clamping to the last day of the target month so
 * a pause that starts on the 31st cannot skip a month.
 */
export function addUtcMonths(timestampMs: number, months: number): number {
  const date = new Date(timestampMs);
  const targetMonthIndex = date.getUTCMonth() + months;
  const lastDayOfTargetMonth = new Date(
    Date.UTC(date.getUTCFullYear(), targetMonthIndex + 1, 0),
  ).getUTCDate();
  return Date.UTC(
    date.getUTCFullYear(),
    targetMonthIndex,
    Math.min(date.getUTCDate(), lastDayOfTargetMonth),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds(),
  );
}

export function computePauseResumeAt(
  currentPeriodEndMs: number,
  months: PauseDurationMonths,
): number {
  return addUtcMonths(currentPeriodEndMs, months);
}

export function discountedAmountDollars(
  amountDollars: number,
  percentOff: number,
): number {
  const cents = Math.round(amountDollars * 100);
  const discountCents = Math.round((cents * percentOff) / 100);
  return (cents - discountCents) / 100;
}

export type SubscriptionPauseMetadata = {
  pauseId?: string;
  months: PauseDurationMonths;
  resumeAtMs: number;
  requestedAtMs?: number;
};

function metadataNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Read a scheduled pause back from Stripe subscription metadata. */
export function subscriptionPauseFromMetadata(
  metadata: Stripe.Metadata | null | undefined,
): SubscriptionPauseMetadata | null {
  if (!metadata) return null;
  const months = metadataNumber(metadata[SUBSCRIPTION_PAUSE_METADATA.months]);
  const resumeAtMs = metadataNumber(
    metadata[SUBSCRIPTION_PAUSE_METADATA.resumeAt],
  );
  if (!isPauseDurationMonths(months) || !resumeAtMs) return null;

  const pauseId = metadata[SUBSCRIPTION_PAUSE_METADATA.pauseId];
  return {
    ...(pauseId && { pauseId }),
    months,
    resumeAtMs,
    requestedAtMs: metadataNumber(
      metadata[SUBSCRIPTION_PAUSE_METADATA.requestedAt],
    ),
  };
}

export function subscriptionPauseMetadata(args: {
  pauseId: string;
  months: PauseDurationMonths;
  resumeAtMs: number;
  requestedAtMs: number;
}): Stripe.MetadataParam {
  return {
    [SUBSCRIPTION_PAUSE_METADATA.pauseId]: args.pauseId,
    [SUBSCRIPTION_PAUSE_METADATA.months]: String(args.months),
    [SUBSCRIPTION_PAUSE_METADATA.resumeAt]: String(args.resumeAtMs),
    [SUBSCRIPTION_PAUSE_METADATA.requestedAt]: String(args.requestedAtMs),
  };
}

/** Stripe unsets metadata keys that are posted as empty strings. */
export function clearedSubscriptionPauseMetadata(): Stripe.MetadataParam {
  return {
    [SUBSCRIPTION_PAUSE_METADATA.pauseId]: "",
    [SUBSCRIPTION_PAUSE_METADATA.months]: "",
    [SUBSCRIPTION_PAUSE_METADATA.resumeAt]: "",
    [SUBSCRIPTION_PAUSE_METADATA.requestedAt]: "",
  };
}

export type RetentionDiscountMetadata = {
  couponId: string;
  percentOff: number;
  durationMonths: number;
  appliedAtMs?: number;
};

export function retentionDiscountFromMetadata(
  metadata: Stripe.Metadata | null | undefined,
): RetentionDiscountMetadata | null {
  if (!metadata) return null;
  const couponId = metadata[RETENTION_DISCOUNT_METADATA.couponId];
  const percentOff = metadataNumber(
    metadata[RETENTION_DISCOUNT_METADATA.percentOff],
  );
  const durationMonths = metadataNumber(
    metadata[RETENTION_DISCOUNT_METADATA.durationMonths],
  );
  if (!couponId || percentOff === undefined || durationMonths === undefined) {
    return null;
  }
  return {
    couponId,
    percentOff,
    durationMonths,
    appliedAtMs: metadataNumber(
      metadata[RETENTION_DISCOUNT_METADATA.appliedAt],
    ),
  };
}

export function retentionDiscountMetadata(args: {
  couponId: string;
  appliedAtMs: number;
}): Stripe.MetadataParam {
  return {
    [RETENTION_DISCOUNT_METADATA.couponId]: args.couponId,
    [RETENTION_DISCOUNT_METADATA.percentOff]: String(
      RETENTION_DISCOUNT.percentOff,
    ),
    [RETENTION_DISCOUNT_METADATA.durationMonths]: String(
      RETENTION_DISCOUNT.durationMonths,
    ),
    [RETENTION_DISCOUNT_METADATA.appliedAt]: String(args.appliedAtMs),
  };
}
