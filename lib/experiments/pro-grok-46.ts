import type { PostHog } from "posthog-node";
import type { ModelName } from "@/lib/ai/providers";
import type { ChatMode, SelectedModel, SubscriptionTier } from "@/types";
import { PAID_INDIVIDUAL_SUBSCRIPTION_TIERS } from "@/types";
import type { ExperimentAnalyticsContext } from "@/lib/analytics/experiment-context";

export const PRO_GROK_46_EXPERIMENT_KEY = "agent_pro_grok_46_model_v1";
export const PRO_GROK_46_EXPOSURE_EVENT =
  "hac64_pro_grok_46_model_experiment_exposed";
export const PRO_GROK_46_FEATURE_PROPERTY = `$feature/${PRO_GROK_46_EXPERIMENT_KEY}`;

export type ProGrok46ExperimentVariant = "control" | "grok_4_6";
export type ProGrok46ModelKey = "model-grok-4.5-pro" | "model-grok-4.6-pro";

export type ProGrok46ExperimentAssignment = {
  key: typeof PRO_GROK_46_EXPERIMENT_KEY;
  variant: ProGrok46ExperimentVariant;
  modelKey: ProGrok46ModelKey;
};

export function isEligibleForProGrok46Experiment({
  subscription,
  mode,
  selectedModel,
}: {
  subscription: SubscriptionTier;
  mode: ChatMode;
  selectedModel?: SelectedModel;
}): boolean {
  return (
    (
      PAID_INDIVIDUAL_SUBSCRIPTION_TIERS as readonly SubscriptionTier[]
    ).includes(subscription) &&
    mode === "agent" &&
    selectedModel === "hackerai-pro"
  );
}

export async function evaluateProGrok46Experiment({
  posthog,
  userId,
  subscription,
  mode,
  selectedModel,
}: {
  posthog: Pick<PostHog, "evaluateFlags"> | null;
  userId: string;
  subscription: SubscriptionTier;
  mode: ChatMode;
  selectedModel?: SelectedModel;
}): Promise<ProGrok46ExperimentAssignment | undefined> {
  if (
    !posthog ||
    !isEligibleForProGrok46Experiment({
      subscription,
      mode,
      selectedModel,
    })
  ) {
    return undefined;
  }

  try {
    const flags = await posthog.evaluateFlags(userId, {
      flagKeys: [PRO_GROK_46_EXPERIMENT_KEY],
    });
    const variant = flags.getFlag(PRO_GROK_46_EXPERIMENT_KEY);

    if (variant !== "control" && variant !== "grok_4_6") {
      return undefined;
    }

    return {
      key: PRO_GROK_46_EXPERIMENT_KEY,
      variant,
      modelKey:
        variant === "grok_4_6" ? "model-grok-4.6-pro" : "model-grok-4.5-pro",
    };
  } catch (error) {
    console.warn("Pro Grok 4.6 experiment evaluation failed", {
      event: "pro_grok_46_experiment_evaluation_failed",
      flag_key: PRO_GROK_46_EXPERIMENT_KEY,
      error_name: error instanceof Error ? error.name : "UnknownError",
    });
    return undefined;
  }
}

export function captureProGrok46ExperimentExposure({
  posthog,
  userId,
  subscription,
  mode,
  selectedModel,
  configuredModel,
  assignment,
}: {
  posthog: Pick<PostHog, "capture"> | null;
  userId: string;
  subscription: SubscriptionTier;
  mode: ChatMode;
  selectedModel: ModelName;
  configuredModel: string;
  assignment?: ProGrok46ExperimentAssignment;
}): void {
  if (!posthog || !assignment) return;

  posthog.capture({
    distinctId: userId,
    event: PRO_GROK_46_EXPOSURE_EVENT,
    properties: {
      experiment_key: assignment.key,
      experiment_variant: assignment.variant,
      [PRO_GROK_46_FEATURE_PROPERTY]: assignment.variant,
      subscription,
      subscription_tier: subscription,
      mode,
      selected_model: selectedModel,
      configured_model: configuredModel,
      exposure_surface: "agent_provider_request",
      $process_person_profile: false,
    },
  });
}

export function getProGrok46ExperimentContext(
  assignment: ProGrok46ExperimentAssignment | undefined,
): ExperimentAnalyticsContext | undefined {
  if (!assignment) return undefined;
  return { key: assignment.key, variant: assignment.variant };
}

export function getActiveProGrok46ExperimentAssignment(
  assignment: ProGrok46ExperimentAssignment | undefined,
  selectedModel: ModelName,
): ProGrok46ExperimentAssignment | undefined {
  return assignment?.modelKey === selectedModel ? assignment : undefined;
}
