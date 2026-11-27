import type Stripe from "stripe";

import {
  PRO_MONTHLY_49_AMOUNT_DOLLARS,
  PRO_MONTHLY_49_PRICE_LOOKUP_KEY,
  PRO_MONTHLY_PRICE_LOOKUP_KEY,
  parseProMonthlyPricePresentation,
  type ProMonthlyAmountDollars,
  type ProMonthlyPriceLookupKey,
  type ProMonthlyPricePresentation,
} from "@/lib/pricing/pro-monthly";
import { PRICING } from "@/lib/pricing/config";

// This proposal uses a fresh, unconfigured flag and assignment namespace so the
// stopped rollout cannot resume from historical stored quotes.
export const HAC248_PRO_MONTHLY_PRICING_KEY =
  "hac248-pro-monthly-49-pricing-proposal";
/**
 * Server-side enrollment with a stable per-account identity: one deterministic
 * UUID and the original assignment time. Delivery is retried on later
 * resolutions, so raw rows can repeat; cohort queries must deduplicate by
 * account or UUID rather than assume the provider already did.
 */
export const HAC248_ENROLLED_EVENT = "hac248_pro_monthly_pricing_enrolled";
/** Client-side, when an assigned monthly Pro quote is actually rendered. */
export const HAC248_EXPOSURE_EVENT = "hac248_pro_monthly_pricing_exposed";

export type Hac248Variant = "control" | "test";

/** The durable per-account assignment and the exact Price it was quoted. */
export type Hac248Assignment = {
  version: 1;
  key: typeof HAC248_PRO_MONTHLY_PRICING_KEY;
  variant: Hac248Variant;
  priceLookupKey: ProMonthlyPriceLookupKey;
  displayedAmountDollars: ProMonthlyAmountDollars;
  stripePriceId: string;
  /** ISO timestamp of the original enrollment. */
  assignedAt: string;
};

export const HAC248_VARIANT_PRICES: Record<
  Hac248Variant,
  {
    priceLookupKey: ProMonthlyPriceLookupKey;
    displayedAmountDollars: ProMonthlyAmountDollars;
  }
> = {
  control: {
    priceLookupKey: PRO_MONTHLY_PRICE_LOOKUP_KEY,
    displayedAmountDollars: PRICING.pro.monthly,
  },
  test: {
    priceLookupKey: PRO_MONTHLY_49_PRICE_LOOKUP_KEY,
    displayedAmountDollars: PRO_MONTHLY_49_AMOUNT_DOLLARS,
  },
};

const METADATA = {
  key: "pricingExperimentKey",
  variant: "pricingExperimentVariant",
  priceLookupKey: "pricingExperimentPriceLookupKey",
  priceId: "pricingExperimentPriceId",
  assignedAt: "pricingExperimentAssignedAt",
} as const;

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 40 &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function buildAssignment(fields: {
  variant: unknown;
  priceLookupKey: unknown;
  stripePriceId: unknown;
  assignedAt: unknown;
}): Hac248Assignment | undefined {
  const variant =
    fields.variant === "control" || fields.variant === "test"
      ? fields.variant
      : undefined;
  if (!variant) return undefined;
  const expected = HAC248_VARIANT_PRICES[variant];
  if (fields.priceLookupKey !== expected.priceLookupKey) return undefined;
  if (
    typeof fields.stripePriceId !== "string" ||
    !fields.stripePriceId.startsWith("price_")
  ) {
    return undefined;
  }
  if (!isIsoTimestamp(fields.assignedAt)) return undefined;
  return {
    version: 1,
    key: HAC248_PRO_MONTHLY_PRICING_KEY,
    variant,
    priceLookupKey: expected.priceLookupKey,
    displayedAmountDollars: expected.displayedAmountDollars,
    stripePriceId: fields.stripePriceId,
    assignedAt: fields.assignedAt,
  };
}

/** Strict parser for stored and transported assignments. */
export function parseHac248Assignment(
  value: unknown,
): Hac248Assignment | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    candidate.key !== HAC248_PRO_MONTHLY_PRICING_KEY
  ) {
    return undefined;
  }
  const assignment = buildAssignment({
    variant: candidate.variant,
    priceLookupKey: candidate.priceLookupKey,
    stripePriceId: candidate.stripePriceId,
    assignedAt: candidate.assignedAt,
  });
  if (
    !assignment ||
    candidate.displayedAmountDollars !== assignment.displayedAmountDollars
  ) {
    return undefined;
  }
  return assignment;
}

export function hac248AssignmentMatchesQuote(
  assignment: Hac248Assignment,
  quote: ProMonthlyPricePresentation,
): boolean {
  return (
    assignment.priceLookupKey === quote.priceLookupKey &&
    assignment.displayedAmountDollars === quote.displayedAmountDollars &&
    assignment.stripePriceId === quote.stripePriceId
  );
}

export function hac248QuoteForAssignment(
  assignment: Hac248Assignment,
): ProMonthlyPricePresentation {
  return {
    priceLookupKey: assignment.priceLookupKey,
    displayedAmountDollars: assignment.displayedAmountDollars,
    currency: "usd",
    billingInterval: "month",
    stripePriceId: assignment.stripePriceId,
  };
}

export function hac248Metadata(
  assignment: Hac248Assignment,
): Stripe.MetadataParam {
  return {
    [METADATA.key]: assignment.key,
    [METADATA.variant]: assignment.variant,
    [METADATA.priceLookupKey]: assignment.priceLookupKey,
    [METADATA.priceId]: assignment.stripePriceId,
    [METADATA.assignedAt]: assignment.assignedAt,
  };
}

/**
 * Attribution survives plan changes: an assigned account that bought another
 * plan keeps its original quote here, independent of the purchased Price.
 */
export function hac248AssignmentFromMetadata(
  metadata: Stripe.Metadata | null | undefined,
): Hac248Assignment | undefined {
  if (metadata?.[METADATA.key] !== HAC248_PRO_MONTHLY_PRICING_KEY) {
    return undefined;
  }
  return buildAssignment({
    variant: metadata[METADATA.variant],
    priceLookupKey: metadata[METADATA.priceLookupKey],
    stripePriceId: metadata[METADATA.priceId],
    assignedAt: metadata[METADATA.assignedAt],
  });
}

/** Experiment properties that never overwrite the purchased Price fields. */
export function hac248Properties(
  assignment: Hac248Assignment,
): Record<string, unknown> {
  return {
    experiment_key: assignment.key,
    experiment_variant: assignment.variant,
    [`$feature/${assignment.key}`]: assignment.variant,
    pricing_experiment_price_lookup_key: assignment.priceLookupKey,
    pricing_experiment_amount_dollars: assignment.displayedAmountDollars,
    pricing_experiment_price_id: assignment.stripePriceId,
    pricing_experiment_assigned_at: assignment.assignedAt,
  };
}

/** Response of the account price endpoint: the quote plus any assignment. */
export type ProMonthlyQuote = {
  price: ProMonthlyPricePresentation;
  assignment?: Hac248Assignment;
};

/**
 * Accept only a self-consistent quote. A $49 Price is never valid without the
 * assignment that quoted it, and an assignment must match its quote exactly.
 */
export function parseProMonthlyQuote(
  value: unknown,
): ProMonthlyQuote | undefined {
  const price = parseProMonthlyPricePresentation(value);
  if (!price) return undefined;
  const rawAssignment = (value as { assignment?: unknown }).assignment;
  if (rawAssignment === undefined || rawAssignment === null) {
    return price.priceLookupKey === PRO_MONTHLY_PRICE_LOOKUP_KEY
      ? { price }
      : undefined;
  }
  const assignment = parseHac248Assignment(rawAssignment);
  if (!assignment || !hac248AssignmentMatchesQuote(assignment, price)) {
    return undefined;
  }
  return { price, assignment };
}
