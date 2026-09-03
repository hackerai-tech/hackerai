import type { PostHog } from "posthog-node";
import type { ExperimentAnalyticsContext } from "@/lib/analytics/experiment-context";
import type { ModelName } from "@/lib/ai/providers";
import type { ChatMode, SelectedModel, SubscriptionTier } from "@/types";

export const DEEPSEEK_V4_PRO_0813_EXPERIMENT_KEY =
  "deepseek_v4_pro_0813_model_v1";
export const DEEPSEEK_V4_PRO_0813_EXPOSURE_EVENT =
  "hac68_deepseek_v4_pro_0813_experiment_exposed";
export const DEEPSEEK_V4_PRO_0813_FEATURE_PROPERTY = `$feature/${DEEPSEEK_V4_PRO_0813_EXPERIMENT_KEY}`;

export type DeepSeekV4Pro0813ExperimentVariant = "control" | "test";
export type DeepSeekV4Pro0813ModelKey =
  "model-deepseek-v4-pro" | "model-deepseek-v4-pro-0813";

export type DeepSeekV4Pro0813ExperimentAssignment = {
  key: typeof DEEPSEEK_V4_PRO_0813_EXPERIMENT_KEY;
  variant: DeepSeekV4Pro0813ExperimentVariant;
  modelKey: DeepSeekV4Pro0813ModelKey;
};

export function isEligibleForDeepSeekV4Pro0813Experiment(
  selectedModel: ModelName,
): selectedModel is "model-deepseek-v4-pro" {
  return selectedModel === "model-deepseek-v4-pro";
}

export async function evaluateDeepSeekV4Pro0813Experiment({
  posthog,
  userId,
  selectedModel,
  requestId,
}: {
  posthog: Pick<PostHog, "evaluateFlags"> | null;
  userId: string;
  selectedModel: ModelName;
  requestId?: string;
}): Promise<DeepSeekV4Pro0813ExperimentAssignment | undefined> {
  if (!posthog || !isEligibleForDeepSeekV4Pro0813Experiment(selectedModel)) {
    return undefined;
  }

  try {
    const flags = await posthog.evaluateFlags(userId, {
      flagKeys: [DEEPSEEK_V4_PRO_0813_EXPERIMENT_KEY],
    });
    const variant = flags.getFlag(DEEPSEEK_V4_PRO_0813_EXPERIMENT_KEY);

    if (variant !== "control" && variant !== "test") {
      return undefined;
    }

    return {
      key: DEEPSEEK_V4_PRO_0813_EXPERIMENT_KEY,
      variant,
      modelKey:
        variant === "test"
          ? "model-deepseek-v4-pro-0813"
          : "model-deepseek-v4-pro",
    };
  } catch (error) {
    console.warn(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "warn",
        event: "deepseek_v4_pro_0813_experiment_evaluation_failed",
        service: "model-routing-experiment",
        environment:
          process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
        request_id: requestId ?? "unavailable",
        user_id: userId,
        flag_key: DEEPSEEK_V4_PRO_0813_EXPERIMENT_KEY,
        error_name: error instanceof Error ? error.name : "UnknownError",
      }),
    );
    return undefined;
  }
}

export function captureDeepSeekV4Pro0813ExperimentExposure({
  posthog,
  userId,
  subscription,
  mode,
  selectedModelOverride,
  selectedModel,
  configuredModel,
  assignment,
}: {
  posthog: Pick<PostHog, "capture"> | null;
  userId: string;
  subscription: SubscriptionTier;
  mode: ChatMode;
  selectedModelOverride?: SelectedModel;
  selectedModel: ModelName;
  configuredModel: string;
  assignment?: DeepSeekV4Pro0813ExperimentAssignment;
}): void {
  if (!posthog || !assignment) return;

  posthog.capture({
    distinctId: userId,
    event: DEEPSEEK_V4_PRO_0813_EXPOSURE_EVENT,
    properties: {
      experiment_key: assignment.key,
      experiment_variant: assignment.variant,
      [DEEPSEEK_V4_PRO_0813_FEATURE_PROPERTY]: assignment.variant,
      subscription,
      subscription_tier: subscription,
      mode,
      selected_model: selectedModel,
      selected_model_override: selectedModelOverride ?? "auto",
      configured_model: configuredModel,
      exposure_surface: "provider_request",
      $process_person_profile: false,
    },
  });
}

export function getDeepSeekV4Pro0813ExperimentContext(
  assignment: DeepSeekV4Pro0813ExperimentAssignment | undefined,
): ExperimentAnalyticsContext | undefined {
  if (!assignment) return undefined;
  return { key: assignment.key, variant: assignment.variant };
}

export function getActiveDeepSeekV4Pro0813ExperimentAssignment(
  assignment: DeepSeekV4Pro0813ExperimentAssignment | undefined,
  selectedModel: ModelName,
): DeepSeekV4Pro0813ExperimentAssignment | undefined {
  return assignment?.modelKey === selectedModel ? assignment : undefined;
}
