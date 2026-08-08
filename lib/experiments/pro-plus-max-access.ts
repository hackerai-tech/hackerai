import type { PostHog } from "posthog-node";
import type { ChatMode, SubscriptionTier } from "@/types";
import type { ExperimentAnalyticsContext } from "@/lib/analytics/experiment-context";

export const PRO_PLUS_MAX_ACCESS_EXPERIMENT_KEY =
  "pro_plus_included_max_access_v1";
export const PRO_PLUS_MAX_ACCESS_EXPOSURE_EVENT =
  "hac59_pro_plus_max_access_experiment_exposed";
export const PRO_PLUS_MAX_ACCESS_FEATURE_PROPERTY = `$feature/${PRO_PLUS_MAX_ACCESS_EXPERIMENT_KEY}`;

export type ProPlusMaxAccessExperimentVariant = "control" | "included_max";

export type ProPlusMaxAccessExperimentAssignment = {
  key: typeof PRO_PLUS_MAX_ACCESS_EXPERIMENT_KEY;
  variant: ProPlusMaxAccessExperimentVariant;
  includedMaxAccess: boolean;
};

export function isEligibleForProPlusMaxAccessExperiment({
  subscription,
  mode,
  extraUsageAvailable,
}: {
  subscription: SubscriptionTier;
  mode: ChatMode;
  extraUsageAvailable: boolean;
}): boolean {
  return (
    subscription === "pro-plus" && mode === "agent" && !extraUsageAvailable
  );
}

export async function evaluateProPlusMaxAccessExperiment({
  posthog,
  userId,
  subscription,
  mode,
  extraUsageAvailable,
  captureExposure = false,
}: {
  posthog: Pick<PostHog, "evaluateFlags" | "capture"> | null;
  userId: string;
  subscription: SubscriptionTier;
  mode: ChatMode;
  extraUsageAvailable: boolean;
  captureExposure?: boolean;
}): Promise<ProPlusMaxAccessExperimentAssignment | undefined> {
  if (
    !posthog ||
    !isEligibleForProPlusMaxAccessExperiment({
      subscription,
      mode,
      extraUsageAvailable,
    })
  ) {
    return undefined;
  }

  try {
    const flags = await posthog.evaluateFlags(userId, {
      flagKeys: [PRO_PLUS_MAX_ACCESS_EXPERIMENT_KEY],
    });
    const variant = flags.getFlag(PRO_PLUS_MAX_ACCESS_EXPERIMENT_KEY);

    if (variant !== "control" && variant !== "included_max") {
      return undefined;
    }

    const assignment: ProPlusMaxAccessExperimentAssignment = {
      key: PRO_PLUS_MAX_ACCESS_EXPERIMENT_KEY,
      variant,
      includedMaxAccess: variant === "included_max",
    };

    if (captureExposure) {
      posthog.capture({
        distinctId: userId,
        event: PRO_PLUS_MAX_ACCESS_EXPOSURE_EVENT,
        properties: {
          experiment_key: assignment.key,
          experiment_variant: assignment.variant,
          [PRO_PLUS_MAX_ACCESS_FEATURE_PROPERTY]: assignment.variant,
          subscription,
          subscription_tier: subscription,
          mode,
          max_access_included: assignment.includedMaxAccess,
          extra_usage_available: false,
          exposure_surface: "agent_model_selector",
          $process_person_profile: false,
        },
      });
    }

    return assignment;
  } catch (error) {
    console.warn("Pro+ Max access experiment evaluation failed", {
      event: "pro_plus_max_access_experiment_evaluation_failed",
      flag_key: PRO_PLUS_MAX_ACCESS_EXPERIMENT_KEY,
      error_name: error instanceof Error ? error.name : "UnknownError",
    });
    return undefined;
  }
}

export function getProPlusMaxAccessExperimentContext(
  assignment: ProPlusMaxAccessExperimentAssignment | undefined,
): ExperimentAnalyticsContext | undefined {
  if (!assignment) return undefined;
  return { key: assignment.key, variant: assignment.variant };
}
