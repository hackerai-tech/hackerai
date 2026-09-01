import type Stripe from "stripe";

export const PRO_MONTHLY_PRICING_EXPERIMENT_KEY =
  "hac46-pro-monthly-29-pricing";
export const PRO_MONTHLY_PRICING_EXPOSURE_EVENT =
  "hac46_pro_monthly_pricing_experiment_exposed";
export const PRO_MONTHLY_PRICING_FEATURE_PROPERTY = `$feature/${PRO_MONTHLY_PRICING_EXPERIMENT_KEY}`;

export const PRO_MONTHLY_CONTROL_LOOKUP_KEY = "pro-monthly-plan";
export const PRO_MONTHLY_TEST_LOOKUP_KEY = "pro-monthly-plan-29-experiment";

export type ProMonthlyPricingExperimentVariant = "control" | "test";

export type ProMonthlyPricingExperimentAssignment = {
  key: typeof PRO_MONTHLY_PRICING_EXPERIMENT_KEY;
  variant: ProMonthlyPricingExperimentVariant;
  priceLookupKey:
    typeof PRO_MONTHLY_CONTROL_LOOKUP_KEY | typeof PRO_MONTHLY_TEST_LOOKUP_KEY;
  displayedAmountDollars: 25 | 29;
  currency: "usd";
  billingInterval: "month";
};

export type ProMonthlyPricingExperimentPresentation =
  ProMonthlyPricingExperimentAssignment & {
    stripePriceId: string;
  };

const ASSIGNMENTS: Record<
  ProMonthlyPricingExperimentVariant,
  ProMonthlyPricingExperimentAssignment
> = {
  control: {
    key: PRO_MONTHLY_PRICING_EXPERIMENT_KEY,
    variant: "control",
    priceLookupKey: PRO_MONTHLY_CONTROL_LOOKUP_KEY,
    displayedAmountDollars: 25,
    currency: "usd",
    billingInterval: "month",
  },
  test: {
    key: PRO_MONTHLY_PRICING_EXPERIMENT_KEY,
    variant: "test",
    priceLookupKey: PRO_MONTHLY_TEST_LOOKUP_KEY,
    displayedAmountDollars: 29,
    currency: "usd",
    billingInterval: "month",
  },
};

export const PRO_MONTHLY_PRICING_METADATA = {
  experimentKey: "pricingExperimentKey",
  experimentVariant: "pricingExperimentVariant",
  priceLookupKey: "pricingExperimentPriceLookupKey",
} as const;

export function isEligibleForProMonthlyPricingExperiment(args: {
  subscription: string;
  requestedPlan: string;
}): boolean {
  return (
    args.subscription === "free" &&
    args.requestedPlan === PRO_MONTHLY_CONTROL_LOOKUP_KEY
  );
}

export function proMonthlyPricingAssignmentForVariant(
  variant: ProMonthlyPricingExperimentVariant,
): ProMonthlyPricingExperimentAssignment {
  return ASSIGNMENTS[variant];
}

export function proMonthlyPricingExperimentMetadata(
  assignment: ProMonthlyPricingExperimentAssignment,
): Stripe.MetadataParam {
  return {
    [PRO_MONTHLY_PRICING_METADATA.experimentKey]: assignment.key,
    [PRO_MONTHLY_PRICING_METADATA.experimentVariant]: assignment.variant,
    [PRO_MONTHLY_PRICING_METADATA.priceLookupKey]: assignment.priceLookupKey,
  };
}

export function proMonthlyPricingExperimentProperties(
  assignment: ProMonthlyPricingExperimentAssignment | undefined,
): Record<string, unknown> {
  if (!assignment) return {};
  const stripePriceId =
    "stripePriceId" in assignment &&
    typeof assignment.stripePriceId === "string"
      ? assignment.stripePriceId
      : undefined;
  return {
    experiment_key: assignment.key,
    experiment_variant: assignment.variant,
    [PRO_MONTHLY_PRICING_FEATURE_PROPERTY]: assignment.variant,
    stripe_price_lookup_key: assignment.priceLookupKey,
    displayed_amount_dollars: assignment.displayedAmountDollars,
    billing_interval: assignment.billingInterval,
    currency: assignment.currency,
    ...(stripePriceId && { stripe_price_id: stripePriceId }),
  };
}

export function proMonthlyPricingAssignmentFromMetadata(
  metadata: Stripe.Metadata | null | undefined,
  priceLookupKey?: string | null,
): ProMonthlyPricingExperimentAssignment | undefined {
  if (
    metadata?.[PRO_MONTHLY_PRICING_METADATA.experimentKey] !==
    PRO_MONTHLY_PRICING_EXPERIMENT_KEY
  ) {
    return undefined;
  }

  const variant =
    metadata[PRO_MONTHLY_PRICING_METADATA.experimentVariant] === "test"
      ? "test"
      : metadata[PRO_MONTHLY_PRICING_METADATA.experimentVariant] === "control"
        ? "control"
        : undefined;
  if (!variant) return undefined;

  const assignment = ASSIGNMENTS[variant];
  const metadataLookupKey =
    metadata[PRO_MONTHLY_PRICING_METADATA.priceLookupKey];
  if (metadataLookupKey !== assignment.priceLookupKey) return undefined;
  if (priceLookupKey && priceLookupKey !== assignment.priceLookupKey) {
    return undefined;
  }

  return assignment;
}
