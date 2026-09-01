import {
  PRO_MONTHLY_PRICING_EXPERIMENT_KEY,
  isEligibleForProMonthlyPricingExperiment,
  proMonthlyPricingAssignmentForVariant,
  proMonthlyPricingAssignmentFromMetadata,
  proMonthlyPricingExperimentMetadata,
  proMonthlyPricingExperimentProperties,
} from "@/lib/experiments/pro-monthly-pricing";

describe("HAC-46 Pro monthly pricing experiment", () => {
  it("limits eligibility to free-user Pro monthly acquisition", () => {
    expect(
      isEligibleForProMonthlyPricingExperiment({
        subscription: "free",
        requestedPlan: "pro-monthly-plan",
      }),
    ).toBe(true);

    for (const input of [
      { subscription: "pro", requestedPlan: "pro-monthly-plan" },
      { subscription: "free", requestedPlan: "pro-yearly-plan" },
      { subscription: "free", requestedPlan: "pro-plus-monthly-plan" },
      { subscription: "free", requestedPlan: "ultra-monthly-plan" },
      { subscription: "free", requestedPlan: "team-monthly-plan" },
    ]) {
      expect(isEligibleForProMonthlyPricingExperiment(input)).toBe(false);
    }
  });

  it("maps variants to an explicit immutable lookup-key allowlist", () => {
    expect(proMonthlyPricingAssignmentForVariant("control")).toMatchObject({
      key: PRO_MONTHLY_PRICING_EXPERIMENT_KEY,
      variant: "control",
      priceLookupKey: "pro-monthly-plan",
      displayedAmountDollars: 25,
    });
    expect(proMonthlyPricingAssignmentForVariant("test")).toMatchObject({
      key: PRO_MONTHLY_PRICING_EXPERIMENT_KEY,
      variant: "test",
      priceLookupKey: "pro-monthly-plan-29-experiment",
      displayedAmountDollars: 29,
    });
  });

  it("round-trips valid Stripe metadata and rejects price mismatches", () => {
    const assignment = proMonthlyPricingAssignmentForVariant("test");
    const metadata = proMonthlyPricingExperimentMetadata(assignment);

    expect(
      proMonthlyPricingAssignmentFromMetadata(
        metadata,
        "pro-monthly-plan-29-experiment",
      ),
    ).toEqual(assignment);
    expect(
      proMonthlyPricingAssignmentFromMetadata(metadata, "pro-monthly-plan"),
    ).toBeUndefined();
  });

  it("includes the resolved Stripe Price ID in client analytics", () => {
    expect(
      proMonthlyPricingExperimentProperties({
        ...proMonthlyPricingAssignmentForVariant("test"),
        stripePriceId: "price_pro_29",
      }),
    ).toMatchObject({
      experiment_variant: "test",
      stripe_price_lookup_key: "pro-monthly-plan-29-experiment",
      stripe_price_id: "price_pro_29",
    });
  });
});
