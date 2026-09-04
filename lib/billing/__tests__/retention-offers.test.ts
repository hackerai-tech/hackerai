import { describe, expect, it } from "@jest/globals";

import {
  PAUSE_COOLDOWN_DAYS,
  addUtcMonths,
  clearedSubscriptionPauseMetadata,
  computePauseResumeAt,
  evaluatePauseOfferEligibility,
  isPauseDurationMonths,
  subscriptionPauseFromMetadata,
  subscriptionPauseMetadata,
  type PauseOfferEligibilityInput,
} from "@/lib/billing/retention-offers";

const NOW = Date.UTC(2026, 8, 4, 12);

function eligibilityInput(
  overrides: Partial<PauseOfferEligibilityInput> = {},
): PauseOfferEligibilityInput {
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
    lastPauseRequestedAtMs: undefined,
    nowMs: NOW,
    ...overrides,
  };
}

describe("evaluatePauseOfferEligibility", () => {
  it("offers a pause to an eligible individual monthly canceller", () => {
    for (const tier of ["pro", "pro-plus", "ultra"] as const) {
      expect(evaluatePauseOfferEligibility(eligibilityInput({ tier }))).toEqual(
        { eligible: true },
      );
    }
  });

  it("shows nothing when the rollout flag is off", () => {
    expect(
      evaluatePauseOfferEligibility(eligibilityInput({ offersEnabled: false })),
    ).toEqual({ eligible: false, reason: "offers_disabled" });
  });

  it("does not offer a pause for yearly, team, or overdue subscriptions", () => {
    expect(
      evaluatePauseOfferEligibility(
        eligibilityInput({ billingInterval: "year" }),
      ),
    ).toEqual({ eligible: false, reason: "unsupported_billing_interval" });
    expect(
      evaluatePauseOfferEligibility(
        eligibilityInput({ tier: "team", quantity: 3 }),
      ),
    ).toEqual({ eligible: false, reason: "multi_seat" });
    expect(
      evaluatePauseOfferEligibility(
        eligibilityInput({ tier: "team", quantity: 1 }),
      ),
    ).toEqual({ eligible: false, reason: "unsupported_tier" });
    expect(
      evaluatePauseOfferEligibility(
        eligibilityInput({ subscriptionStatus: "past_due" }),
      ),
    ).toEqual({ eligible: false, reason: "subscription_not_active" });
    expect(
      evaluatePauseOfferEligibility(
        eligibilityInput({ cancelAtPeriodEnd: true }),
      ),
    ).toEqual({ eligible: false, reason: "cancellation_already_scheduled" });
  });

  it("matches the offer to the cancellation reason", () => {
    expect(
      evaluatePauseOfferEligibility(
        eligibilityInput({ reasonCategory: "results_not_good_enough" }),
      ),
    ).toEqual({ eligible: false, reason: "reason_not_applicable" });
    expect(
      evaluatePauseOfferEligibility(
        eligibilityInput({ reasonCategory: "temporary_pause" }),
      ),
    ).toEqual({ eligible: true });
    expect(
      evaluatePauseOfferEligibility(
        eligibilityInput({ reasonCategory: "not_using_enough" }),
      ),
    ).toEqual({ eligible: true });
  });

  it("enforces the pause cooldown", () => {
    expect(
      evaluatePauseOfferEligibility(
        eligibilityInput({
          lastPauseRequestedAtMs: NOW - (PAUSE_COOLDOWN_DAYS - 1) * 86_400_000,
        }),
      ),
    ).toEqual({ eligible: false, reason: "pause_cooldown" });
    expect(
      evaluatePauseOfferEligibility(
        eligibilityInput({
          lastPauseRequestedAtMs: NOW - (PAUSE_COOLDOWN_DAYS + 1) * 86_400_000,
        }),
      ),
    ).toEqual({ eligible: true });
  });

  it("requires a paid-through date to schedule a pause", () => {
    expect(
      evaluatePauseOfferEligibility(
        eligibilityInput({ currentPeriodEndMs: undefined }),
      ),
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
});
