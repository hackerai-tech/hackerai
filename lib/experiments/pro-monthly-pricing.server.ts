import {
  PRO_MONTHLY_PRICING_EXPERIMENT_KEY,
  isEligibleForProMonthlyPricingExperiment,
  proMonthlyPricingAssignmentForVariant,
  type ProMonthlyPricingExperimentAssignment,
} from "@/lib/experiments/pro-monthly-pricing";
import { getPostHogFeatureFlagVariantForUser } from "@/lib/posthog/server";

export async function evaluateProMonthlyPricingExperiment(args: {
  userId: string;
  subscription: string;
  requestedPlan: string;
}): Promise<ProMonthlyPricingExperimentAssignment | undefined> {
  if (!isEligibleForProMonthlyPricingExperiment(args)) return undefined;

  const flagValue = await getPostHogFeatureFlagVariantForUser(
    PRO_MONTHLY_PRICING_EXPERIMENT_KEY,
    args.userId,
    { sendFeatureFlagEvents: false },
  );

  // Fail closed to the established price. The only value authorized to select
  // the experimental Stripe Price is the explicit PostHog `test` variant.
  return proMonthlyPricingAssignmentForVariant(
    flagValue === "test" ? "test" : "control",
  );
}
