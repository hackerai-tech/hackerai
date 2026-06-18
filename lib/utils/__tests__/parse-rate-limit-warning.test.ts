import { describe, expect, it } from "@jest/globals";
import { parseRateLimitWarning } from "../parse-rate-limit-warning";

describe("parseRateLimitWarning", () => {
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
        },
        { hasUserDismissed: false },
      ),
    ).toBeNull();
  });
});
