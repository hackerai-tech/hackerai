import { describe, expect, it } from "@jest/globals";

import {
  PAUSE_COOLDOWN_DAYS,
  RETENTION_DISCOUNT,
  addUtcMonths,
  clearedSubscriptionPauseMetadata,
  computePauseResumeAt,
  discountedAmountDollars,
  evaluateRetentionOfferEligibility,
  isPauseDurationMonths,
  retentionDiscountFromMetadata,
  retentionDiscountMetadata,
  subscriptionPauseFromMetadata,
  subscriptionPauseMetadata,
  type RetentionOfferEligibilityInput,
} from "@/lib/billing/retention-offers";

const NOW = Date.UTC(2026, 8, 4, 12);

function eligibilityInput(
  overrides: Partial<RetentionOfferEligibilityInput> = {},
): RetentionOfferEligibilityInput {
  return {
    offersEnabled: true,
    tier: "pro-plus",
    billingInterval: "month",
    billingIntervalCount: 1,
    subscriptionStatus: "active",
    cancelAtPeriodEnd: false,
    quantity: 1,
    reasonCategory: "too_expensive",
    currentPeriodEndMs: NOW + 10 * 86_400_000,
    hasExistingDiscount: false,
    retentionDiscountAlreadyApplied: false,
    lastPauseRequestedAtMs: undefined,
    nowMs: NOW,
    ...overrides,
  };
}

describe("evaluateRetentionOfferEligibility", () => {
  it("offers both pause and discount to an eligible Pro+ monthly canceller", () => {
    expect(evaluateRetentionOfferEligibility(eligibilityInput())).toEqual({
      pause: { eligible: true },
      discount: { eligible: true },
    });
  });

  it("shows nothing when the rollout flag is off", () => {
    expect(
      evaluateRetentionOfferEligibility(
        eligibilityInput({ offersEnabled: false }),
      ),
    ).toEqual({
      pause: { eligible: false, reason: "offers_disabled" },
      discount: { eligible: false, reason: "offers_disabled" },
    });
  });

  it("keeps Pro discount-free so the pricing experiment stays clean", () => {
    const result = evaluateRetentionOfferEligibility(
      eligibilityInput({ tier: "pro" }),
    );

    expect(result.pause).toEqual({ eligible: true });
    expect(result.discount).toEqual({
      eligible: false,
      reason: "unsupported_tier",
    });
  });

  it("does not offer anything for yearly, team, or overdue subscriptions", () => {
    expect(
      evaluateRetentionOfferEligibility(
        eligibilityInput({ billingInterval: "year" }),
      ).pause,
    ).toEqual({ eligible: false, reason: "unsupported_billing_interval" });
    expect(
      evaluateRetentionOfferEligibility(
        eligibilityInput({ tier: "team", quantity: 3 }),
      ).discount,
    ).toEqual({ eligible: false, reason: "multi_seat" });
    expect(
      evaluateRetentionOfferEligibility(
        eligibilityInput({ subscriptionStatus: "past_due" }),
      ).pause,
    ).toEqual({ eligible: false, reason: "subscription_not_active" });
    expect(
      evaluateRetentionOfferEligibility(
        eligibilityInput({ cancelAtPeriodEnd: true }),
      ).discount,
    ).toEqual({ eligible: false, reason: "cancellation_already_scheduled" });
  });

  it("matches offers to the cancellation reason", () => {
    const quality = evaluateRetentionOfferEligibility(
      eligibilityInput({ reasonCategory: "results_not_good_enough" }),
    );
    expect(quality.pause).toEqual({
      eligible: false,
      reason: "reason_not_applicable",
    });
    expect(quality.discount).toEqual({
      eligible: false,
      reason: "reason_not_applicable",
    });

    const temporary = evaluateRetentionOfferEligibility(
      eligibilityInput({ reasonCategory: "temporary_pause" }),
    );
    expect(temporary.pause).toEqual({ eligible: true });
    expect(temporary.discount).toEqual({
      eligible: false,
      reason: "reason_not_applicable",
    });
  });

  it("enforces the pause cooldown and single-discount rules", () => {
    const recentPause = evaluateRetentionOfferEligibility(
      eligibilityInput({
        lastPauseRequestedAtMs: NOW - (PAUSE_COOLDOWN_DAYS - 1) * 86_400_000,
      }),
    );
    expect(recentPause.pause).toEqual({
      eligible: false,
      reason: "pause_cooldown",
    });

    const oldPause = evaluateRetentionOfferEligibility(
      eligibilityInput({
        lastPauseRequestedAtMs: NOW - (PAUSE_COOLDOWN_DAYS + 1) * 86_400_000,
      }),
    );
    expect(oldPause.pause).toEqual({ eligible: true });

    expect(
      evaluateRetentionOfferEligibility(
        eligibilityInput({ retentionDiscountAlreadyApplied: true }),
      ).discount,
    ).toEqual({ eligible: false, reason: "discount_already_applied" });
    expect(
      evaluateRetentionOfferEligibility(
        eligibilityInput({ hasExistingDiscount: true }),
      ).discount,
    ).toEqual({ eligible: false, reason: "discount_already_applied" });
  });

  it("requires a paid-through date to schedule a pause", () => {
    expect(
      evaluateRetentionOfferEligibility(
        eligibilityInput({ currentPeriodEndMs: undefined }),
      ).pause,
    ).toEqual({ eligible: false, reason: "missing_period_end" });
  });
});

describe("pause date math", () => {
  it("adds calendar months and clamps to the shorter month", () => {
    expect(addUtcMonths(Date.UTC(2026, 0, 31, 9, 30), 1)).toBe(
      Date.UTC(2026, 1, 28, 9, 30),
    );
    expect(computePauseResumeAt(Date.UTC(2026, 10, 15), 3)).toBe(
      Date.UTC(2027, 1, 15),
    );
  });

  it("only accepts the supported pause durations", () => {
    expect(isPauseDurationMonths(1)).toBe(true);
    expect(isPauseDurationMonths(3)).toBe(true);
    expect(isPauseDurationMonths(4)).toBe(false);
    expect(isPauseDurationMonths("2")).toBe(false);
  });
});

describe("Stripe metadata round trips", () => {
  it("serialises and reads a scheduled pause", () => {
    const metadata = subscriptionPauseMetadata({
      pauseId: "pause_1",
      months: 2,
      resumeAtMs: NOW + 60 * 86_400_000,
      requestedAtMs: NOW,
    });

    expect(subscriptionPauseFromMetadata(metadata as never)).toEqual({
      pauseId: "pause_1",
      months: 2,
      resumeAtMs: NOW + 60 * 86_400_000,
      requestedAtMs: NOW,
    });
    expect(
      subscriptionPauseFromMetadata({ hackeraiPauseMonths: "9" } as never),
    ).toBeNull();
    expect(
      Object.values(clearedSubscriptionPauseMetadata()).every(
        (value) => value === "",
      ),
    ).toBe(true);
  });

  it("serialises and reads a retention discount", () => {
    const metadata = retentionDiscountMetadata({
      couponId: "coupon_1",
      appliedAtMs: NOW,
    });

    expect(retentionDiscountFromMetadata(metadata as never)).toEqual({
      couponId: "coupon_1",
      percentOff: RETENTION_DISCOUNT.percentOff,
      durationMonths: RETENTION_DISCOUNT.durationMonths,
      appliedAtMs: NOW,
    });
    expect(retentionDiscountFromMetadata({})).toBeNull();
  });

  it("rounds discounted amounts to cents", () => {
    expect(discountedAmountDollars(60, 50)).toBe(30);
    expect(discountedAmountDollars(29, 50)).toBe(14.5);
    expect(discountedAmountDollars(19.99, 50)).toBe(9.99);
  });
});
