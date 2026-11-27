import type Stripe from "stripe";

import {
  proMonthlyPricingAssignmentFromMetadata,
  proMonthlyPricingExperimentProperties,
  PRO_MONTHLY_PRICING_EXPERIMENT_KEY,
  type ProMonthlyPricingExperimentAssignment,
} from "./pro-monthly-pricing";
import {
  hac248AssignmentFromMetadata,
  hac248Properties,
  type Hac248Assignment,
} from "./pro-monthly-pricing-hac248";

/** Retired HAC-46 attribution or current HAC-248 attribution. */
export type ProMonthlyPricingAttribution =
  ProMonthlyPricingExperimentAssignment | Hac248Assignment;

/**
 * Lifecycle events (renewals, cancellation, pause, downgrade) read the
 * subscription's original pricing attribution. HAC-46 keeps its strict
 * lookup-key match; HAC-248 is independent of the purchased Price.
 */
export function proMonthlyPricingAttributionFromMetadata(
  metadata: Stripe.Metadata | null | undefined,
  priceLookupKey?: string | null,
): ProMonthlyPricingAttribution | undefined {
  return (
    proMonthlyPricingAssignmentFromMetadata(metadata, priceLookupKey) ??
    hac248AssignmentFromMetadata(metadata)
  );
}

export function proMonthlyPricingAttributionProperties(
  attribution: ProMonthlyPricingAttribution | undefined,
): Record<string, unknown> {
  if (!attribution) return {};
  if (attribution.key === PRO_MONTHLY_PRICING_EXPERIMENT_KEY) {
    return proMonthlyPricingExperimentProperties(attribution);
  }
  return hac248Properties(attribution);
}
