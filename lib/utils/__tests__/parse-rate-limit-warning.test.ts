import { describe, expect, it } from "@jest/globals";
import { parseRateLimitWarning } from "../parse-rate-limit-warning";

describe("parseRateLimitWarning", () => {
  it("keeps daily warnings visible despite a monthly info cooldown and the next day's reset", () => {
    localStorage.clear();
    const warning = {
      warningType: "token-bucket",
      subscription: "free",
      bucketType: "monthly",
      severity: "info",
      remainingPercent: 25,
      resetTime: "2026-10-02T00:00:00.000Z",
    };
    const options = { hasUserDismissed: false };
    expect(parseRateLimitWarning(warning, options)).not.toBeNull();
    expect(parseRateLimitWarning(warning, options)).toBeNull();
    expect(
      parseRateLimitWarning({ ...warning, bucketType: "daily" }, options),
    ).not.toBeNull();
    expect(
      parseRateLimitWarning(
        {
          ...warning,
          bucketType: "daily",
          resetTime: "2026-10-03T00:00:00.000Z",
        },
        options,
      ),
    ).not.toBeNull();
    localStorage.clear();
  });

  it("parses paid daily Agent allowance notices", () => {
    expect(
      parseRateLimitWarning(
        {
          warningType: "paid-daily-free-allowance",
          subscription: "pro",
          mode: "agent",
          resetTime: "2026-06-30T00:00:00.000Z",
          costLimitDollars: 0.25,
        },
        { hasUserDismissed: false },
      ),
    ).toMatchObject({
      warningType: "paid-daily-free-allowance",
      subscription: "pro",
      mode: "agent",
      costLimitDollars: 0.25,
    });
  });

  it("rejects paid daily allowance notices for free users", () => {
    expect(
      parseRateLimitWarning(
        {
          warningType: "paid-daily-free-allowance",
          subscription: "free",
          mode: "agent",
          resetTime: "2026-06-30T00:00:00.000Z",
          costLimitDollars: 0.25,
        },
        { hasUserDismissed: false },
      ),
    ).toBeNull();
  });

  it("rejects paid daily allowance notices for team subscriptions", () => {
    expect(
      parseRateLimitWarning(
        {
          warningType: "paid-daily-free-allowance",
          subscription: "team",
          mode: "agent",
          resetTime: "2026-06-30T00:00:00.000Z",
          costLimitDollars: 0.25,
        },
        { hasUserDismissed: false },
      ),
    ).toBeNull();
  });

  it("parses Pro Agent per-run spend-cap warnings", () => {
    const parsed = parseRateLimitWarning(
      {
        warningType: "agent-run-spend-cap",
        subscription: "pro",
        mode: "agent",
        resetTime: "2026-06-30T00:00:00.000Z",
        runCostDollars: 5.2,
        runCapDollars: 5,
        monthlyRemainingDollars: 18,
        capBasis: "fixed_5_dollars",
        premiumContinuationAllowed: true,
        midStream: true,
      },
      { hasUserDismissed: false },
    );

    expect(parsed).toMatchObject({
      warningType: "agent-run-spend-cap",
      subscription: "pro",
      mode: "agent",
      runCostDollars: 5.2,
      runCapDollars: 5,
      monthlyRemainingDollars: 18,
      capBasis: "fixed_5_dollars",
      premiumContinuationAllowed: true,
      midStream: true,
    });
  });

  it("rejects per-run spend-cap warnings outside Pro", () => {
    expect(
      parseRateLimitWarning(
        {
          warningType: "agent-run-spend-cap",
          subscription: "pro-plus",
          mode: "agent",
          resetTime: "2026-06-30T00:00:00.000Z",
          runCostDollars: 5.2,
          runCapDollars: 5,
          monthlyRemainingDollars: 18,
          capBasis: "fixed_5_dollars",
          premiumContinuationAllowed: true,
        },
        { hasUserDismissed: false },
      ),
    ).toBeNull();
  });

  it("rejects per-run spend-cap warnings outside Agent mode", () => {
    expect(
      parseRateLimitWarning(
        {
          warningType: "agent-run-spend-cap",
          subscription: "pro",
          mode: "ask",
          resetTime: "2026-06-30T00:00:00.000Z",
          runCostDollars: 5.2,
          runCapDollars: 5,
          monthlyRemainingDollars: 18,
          capBasis: "fixed_5_dollars",
          premiumContinuationAllowed: true,
        },
        { hasUserDismissed: false },
      ),
    ).toBeNull();
  });

  it.each([
    { capBasis: "unknown_basis" },
    { capBasis: "remaining_25_percent" },
    { capBasis: "remaining_exhausted" },
    { runCostDollars: -1 },
    { runCapDollars: -1 },
    { monthlyRemainingDollars: -1 },
    { runCostDollars: Number.NaN },
    { runCapDollars: Number.POSITIVE_INFINITY },
    { monthlyRemainingDollars: Number.NEGATIVE_INFINITY },
    { premiumContinuationAllowed: undefined },
    { premiumContinuationAllowed: "true" },
  ])("rejects invalid spend-cap payload: %o", (overrides) => {
    expect(
      parseRateLimitWarning(
        {
          warningType: "agent-run-spend-cap",
          subscription: "pro",
          mode: "agent",
          resetTime: "2026-06-30T00:00:00.000Z",
          runCostDollars: 5.2,
          runCapDollars: 5,
          monthlyRemainingDollars: 18,
          capBasis: "fixed_5_dollars",
          premiumContinuationAllowed: true,
          ...overrides,
        },
        { hasUserDismissed: false },
      ),
    ).toBeNull();
  });
});
