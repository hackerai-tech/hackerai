import {
  getEligibleLimitCtas,
  getExtraUsageLimitCta,
  getLimitPressureContext,
  shouldShowUpgradeCta,
} from "../limit-pressure";

describe("limit pressure helpers", () => {
  it("routes free limit pressure to upgrade only", () => {
    expect(
      getLimitPressureContext({
        subscription: "free",
        capReason: "daily_requests_exhausted",
      }),
    ).toMatchObject({
      limitType: "daily_requests",
      upgradeAvailable: true,
      addCreditAvailable: false,
      primaryCta: "upgrade_plan",
      eligibleCtas: ["upgrade_plan"],
    });
  });

  it("routes paid monthly exhaustion to add credits and paid upgrades when available", () => {
    expect(
      getEligibleLimitCtas({
        subscription: "pro",
        capReason: "monthly_exhausted",
      }),
    ).toEqual(["add_credits", "upgrade_plan"]);
    expect(
      getExtraUsageLimitCta({
        subscription: "ultra",
        capReason: "monthly_exhausted",
      }),
    ).toMatchObject({
      label: "Add Credits",
      analyticsText: "Add Credits",
    });
  });

  it("routes extra-usage caps to the spending-limit guardrail instead of upgrade", () => {
    expect(
      shouldShowUpgradeCta({
        subscription: "pro-plus",
        capReason: "extra_usage_cap",
      }),
    ).toBe(false);
    expect(
      getExtraUsageLimitCta({
        subscription: "pro-plus",
        capReason: "extra_usage_cap",
      }),
    ).toMatchObject({
      label: "Increase Limit",
      analyticsText: "Increase Limit",
    });
  });
});
