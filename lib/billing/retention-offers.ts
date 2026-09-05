import type Stripe from "stripe";

import type { CancellationReasonCategory } from "@/lib/billing/cancellation-reasons";
import type { SubscriptionTier } from "@/types";

/**
 * Retention "pause" offer shown inside the in-app cancellation flow.
 *
 * The plan ends at the paid-through date and is re-created automatically
 * (same price, saved card) after the chosen number of months. Eligibility is
 * deliberately conservative and reason-aware so the offer is shown to people
 * whose stated reason a pause can actually address.
 */
export const PAUSE_OFFER_FLAG_KEY = "hac-96-pause-subscription-offer";
export const DOWNGRADE_OFFER_FLAG_KEY = "hac-97-downgrade-offer";

export type RetentionOfferType = "pause" | "downgrade";

export const PAUSE_DURATION_MONTH_OPTIONS = [1, 2, 3] as const;
export type PauseDurationMonths = (typeof PAUSE_DURATION_MONTH_OPTIONS)[number];

/** Minimum gap between two pauses for the same user. */
export const PAUSE_COOLDOWN_DAYS = 180;

/** Automatic resume retries before the pause is marked as failed. */
export const PAUSE_RESUME_MAX_ATTEMPTS = 3;
/** Delay between automatic resume retries after a retryable payment failure. */
export const PAUSE_RESUME_RETRY_DELAY_MS = 24 * 60 * 60 * 1000;

const PAUSE_ELIGIBLE_TIERS: ReadonlySet<SubscriptionTier> = new Set([
  "pro",
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

/**
 * Downgrade offer: one tier down, same billing interval. Pro has no cheaper
 * paid tier, so it is never offered a downgrade.
 */
export const DOWNGRADE_TARGETS: Partial<
  Record<SubscriptionTier, { tier: SubscriptionTier; lookupKey: string }>
> = {
  "pro-plus": { tier: "pro", lookupKey: "pro-monthly-plan" },
  ultra: { tier: "pro-plus", lookupKey: "pro-plus-monthly-plan" },
};

const DOWNGRADE_REASONS: ReadonlySet<CancellationReasonCategory> = new Set([
  "too_expensive",
  "not_using_enough",
  "other",
]);

export const RETENTION_DOWNGRADE_METADATA = {
  fromPlan: "hackeraiRetentionDowngradeFromPlan",
  appliedAt: "hackeraiRetentionDowngradeAppliedAt",
} as const;

export const RETENTION_DOWNGRADE_CHECKOUT_SOURCE = "retention_downgrade";

export function downgradeTargetForTier(
  tier: SubscriptionTier | undefined,
): { tier: SubscriptionTier; lookupKey: string } | undefined {
  return tier ? DOWNGRADE_TARGETS[tier] : undefined;
}

export type DowngradeOfferIneligibilityReason =
  | "offers_disabled"
  | "no_downgrade_target"
  | "unsupported_billing_interval"
  | "subscription_not_active"
  | "cancellation_already_scheduled"
  | "reason_not_applicable"
  | "multi_seat"
  | "downgrade_already_applied";

export type DowngradeOfferEligibilityInput = {
  offersEnabled: boolean;
  tier: SubscriptionTier | undefined;
  billingInterval: string | undefined;
  billingIntervalCount?: number | null;
  subscriptionStatus: Stripe.Subscription.Status | string;
  cancelAtPeriodEnd: boolean;
  quantity?: number | null;
  reasonCategory: CancellationReasonCategory;
  downgradeAlreadyApplied: boolean;
};

export type DowngradeOfferEligibility =
  | { eligible: true; target: { tier: SubscriptionTier; lookupKey: string } }
  | { eligible: false; reason: DowngradeOfferIneligibilityReason };

export function evaluateDowngradeOfferEligibility(
  input: DowngradeOfferEligibilityInput,
): DowngradeOfferEligibility {
  if (!input.offersEnabled) {
    return { eligible: false, reason: "offers_disabled" };
  }
  const target = downgradeTargetForTier(input.tier);
  if (!target) {
    return { eligible: false, reason: "no_downgrade_target" };
  }
  if (
    input.subscriptionStatus !== "active" &&
    input.subscriptionStatus !== "trialing"
  ) {
    return { eligible: false, reason: "subscription_not_active" };
  }
  if (input.cancelAtPeriodEnd) {
    return { eligible: false, reason: "cancellation_already_scheduled" };
  }
  if (
    input.billingInterval !== "month" ||
    (input.billingIntervalCount ?? 1) !== 1
  ) {
    return { eligible: false, reason: "unsupported_billing_interval" };
  }
  if ((input.quantity ?? 1) !== 1) {
    return { eligible: false, reason: "multi_seat" };
  }
  if (!DOWNGRADE_REASONS.has(input.reasonCategory)) {
    return { eligible: false, reason: "reason_not_applicable" };
  }
  if (input.downgradeAlreadyApplied) {
    return { eligible: false, reason: "downgrade_already_applied" };
  }
  return { eligible: true, target };
}

export function retentionDowngradeFromMetadata(
  metadata: Stripe.Metadata | null | undefined,
): { fromPlan: string; appliedAtMs?: number } | null {
  const fromPlan = metadata?.[RETENTION_DOWNGRADE_METADATA.fromPlan];
  if (!fromPlan) return null;
  const appliedAt = Number(metadata?.[RETENTION_DOWNGRADE_METADATA.appliedAt]);
  return {
    fromPlan,
    ...(Number.isFinite(appliedAt) &&
      appliedAt > 0 && { appliedAtMs: appliedAt }),
  };
}

export function retentionDowngradeMetadata(args: {
  fromPlan: string;
  appliedAtMs: number;
}): Stripe.MetadataParam {
  return {
    [RETENTION_DOWNGRADE_METADATA.fromPlan]: args.fromPlan,
    [RETENTION_DOWNGRADE_METADATA.appliedAt]: String(args.appliedAtMs),
  };
}

export const SUBSCRIPTION_PAUSE_METADATA = {
  pauseId: "hackeraiPauseId",
  months: "hackeraiPauseMonths",
  resumeAt: "hackeraiPauseResumeAt",
  requestedAt: "hackeraiPauseRequestedAt",
} as const;

export const PAUSE_RESUME_CHECKOUT_TYPE = "pause_resume";

export type PauseOfferIneligibilityReason =
  | "offers_disabled"
  | "unsupported_tier"
  | "unsupported_billing_interval"
  | "subscription_not_active"
  | "cancellation_already_scheduled"
  | "reason_not_applicable"
  | "multi_seat"
  | "pause_cooldown"
  | "missing_period_end";

export type PauseOfferEligibilityInput = {
  offersEnabled: boolean;
  tier: SubscriptionTier | undefined;
  billingInterval: string | undefined;
  billingIntervalCount?: number | null;
  subscriptionStatus: Stripe.Subscription.Status | string;
  cancelAtPeriodEnd: boolean;
  quantity?: number | null;
  reasonCategory: CancellationReasonCategory;
  currentPeriodEndMs: number | undefined;
  lastPauseRequestedAtMs: number | undefined;
  nowMs?: number;
};

export type PauseOfferEligibility =
  | { eligible: true }
  | { eligible: false; reason: PauseOfferIneligibilityReason };

export function evaluatePauseOfferEligibility(
  input: PauseOfferEligibilityInput,
): PauseOfferEligibility {
  if (!input.offersEnabled) {
    return { eligible: false, reason: "offers_disabled" };
  }
  if (
    input.subscriptionStatus !== "active" &&
    input.subscriptionStatus !== "trialing"
  ) {
    return { eligible: false, reason: "subscription_not_active" };
  }
  if (input.cancelAtPeriodEnd) {
    return { eligible: false, reason: "cancellation_already_scheduled" };
  }
  if (
    input.billingInterval !== "month" ||
    (input.billingIntervalCount ?? 1) !== 1
  ) {
    return { eligible: false, reason: "unsupported_billing_interval" };
  }
  if ((input.quantity ?? 1) !== 1) {
    return { eligible: false, reason: "multi_seat" };
  }
  if (!input.tier || !PAUSE_ELIGIBLE_TIERS.has(input.tier)) {
    return { eligible: false, reason: "unsupported_tier" };
  }
  if (!PAUSE_REASONS.has(input.reasonCategory)) {
    return { eligible: false, reason: "reason_not_applicable" };
  }
  if (!input.currentPeriodEndMs) {
    return { eligible: false, reason: "missing_period_end" };
  }

  const nowMs = input.nowMs ?? Date.now();
  if (
    input.lastPauseRequestedAtMs !== undefined &&
    nowMs - input.lastPauseRequestedAtMs <
      PAUSE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000
  ) {
    return { eligible: false, reason: "pause_cooldown" };
  }

  return { eligible: true };
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
