import {
  proMonthlyPricingAttributionFromMetadata,
  proMonthlyPricingAttributionProperties,
} from "@/lib/experiments/pro-monthly-pricing-attribution";
import {
  proMonthlyPricingAssignmentForVariant,
  proMonthlyPricingExperimentMetadata,
} from "@/lib/experiments/pro-monthly-pricing";
import { hac248Metadata } from "@/lib/experiments/pro-monthly-pricing-hac248";

const hac248Assignment = {
  version: 1 as const,
  key: "hac248-pro-monthly-49-pricing" as const,
  variant: "test" as const,
  priceLookupKey: "pro-monthly-plan-49-hac248" as const,
  displayedAmountDollars: 49 as const,
  stripePriceId: "price_pro_49",
  assignedAt: "2026-11-20T10:00:00.000Z",
};

describe("shared pricing attribution", () => {
  it("keeps historical HAC-46 subscriptions on their strict legacy parser", () => {
    const legacy = proMonthlyPricingAssignmentForVariant("test");
    const metadata = proMonthlyPricingExperimentMetadata(legacy) as Record<
      string,
      string
    >;
    expect(
      proMonthlyPricingAttributionFromMetadata(
        metadata,
        "pro-monthly-plan-29-experiment",
      ),
    ).toEqual(legacy);
    expect(
      proMonthlyPricingAttributionFromMetadata(metadata, "pro-monthly-plan"),
    ).toBeUndefined();
    expect(proMonthlyPricingAttributionProperties(legacy)).toMatchObject({
      "$feature/hac46-pro-monthly-29-pricing": "test",
      stripe_price_lookup_key: "pro-monthly-plan-29-experiment",
      displayed_amount_dollars: 29,
    });
  });

  it("keeps a HAC-248 assignment attached after the account buys another plan", () => {
    const metadata = hac248Metadata(hac248Assignment) as Record<string, string>;
    expect(
      proMonthlyPricingAttributionFromMetadata(
        metadata,
        "pro-plus-monthly-plan",
      ),
    ).toEqual(hac248Assignment);
  });

  it("reports HAC-248 under its own feature key without overwriting purchased-Price fields", () => {
    const properties = proMonthlyPricingAttributionProperties(hac248Assignment);
    expect(properties).toMatchObject({
      experiment_key: "hac248-pro-monthly-49-pricing",
      experiment_variant: "test",
      "$feature/hac248-pro-monthly-49-pricing": "test",
      pricing_experiment_amount_dollars: 49,
      pricing_experiment_assigned_at: "2026-11-20T10:00:00.000Z",
    });
    // Lifecycle events set these from the Price actually charged.
    expect(properties).not.toHaveProperty("stripe_price_lookup_key");
    expect(properties).not.toHaveProperty("stripe_price_id");
    expect(properties).not.toHaveProperty("displayed_amount_dollars");
  });

  it("adds nothing for an unattributed subscription", () => {
    expect(proMonthlyPricingAttributionFromMetadata({})).toBeUndefined();
    expect(proMonthlyPricingAttributionProperties(undefined)).toEqual({});
  });
});
