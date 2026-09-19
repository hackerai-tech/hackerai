import type { PostHog } from "posthog-node";
import type { ModelName } from "@/lib/ai/providers";
import { getExperimentAnalyticsProperties } from "@/lib/analytics/experiment-context";
import type { ChatMode, SubscriptionTier } from "@/types";

export const ULTRA_MAX_MODEL_EXPERIMENT_KEY = "ultra_max_glm_5_3_v1";
export const ULTRA_MAX_MODEL_EXPOSURE_EVENT =
  "ultra_max_model_experiment_exposed";

export type UltraMaxModelAssignment = {
  key: typeof ULTRA_MAX_MODEL_EXPERIMENT_KEY;
  variant: "control" | "test";
  modelKey: "model-grok-4.6" | "model-glm-5.3";
  configuredModel: "x-ai/grok-4.6" | "z-ai/glm-5.3";
};

export async function evaluateUltraMaxModel({
  posthog,
  userId,
  subscription,
  selectedModel,
  hasImages,
}: {
  posthog: Pick<PostHog, "getFeatureFlag"> | null;
  userId: string;
  subscription: SubscriptionTier;
  selectedModel: ModelName;
  hasImages: boolean;
}): Promise<UltraMaxModelAssignment | undefined> {
  if (
    !posthog ||
    !userId ||
    subscription !== "ultra" ||
    selectedModel !== "model-grok-4.6" ||
    hasImages
  )
    return undefined;

  try {
    // Assignment is not exposure. Suppress the SDK's flag event and emit the
    // experiment exposure only when this request reaches the provider.
    const variant = await posthog.getFeatureFlag(
      ULTRA_MAX_MODEL_EXPERIMENT_KEY,
      userId,
      {
        sendFeatureFlagEvents: false,
        personProperties: { subscription, subscription_tier: subscription },
      },
    );
    if (variant !== "control" && variant !== "test") return undefined;

    return variant === "test"
      ? {
          key: ULTRA_MAX_MODEL_EXPERIMENT_KEY,
          variant,
          modelKey: "model-glm-5.3",
          configuredModel: "z-ai/glm-5.3",
        }
      : {
          key: ULTRA_MAX_MODEL_EXPERIMENT_KEY,
          variant,
          modelKey: "model-grok-4.6",
          configuredModel: "x-ai/grok-4.6",
        };
  } catch {
    // Analytics availability must never interrupt chat or change the baseline.
    return undefined;
  }
}

export function getActiveUltraMaxModelAssignment(
  assignment: UltraMaxModelAssignment | undefined,
  selectedModel: ModelName,
  isPaidAllowanceRescue: boolean,
): UltraMaxModelAssignment | undefined {
  return !isPaidAllowanceRescue && assignment?.modelKey === selectedModel
    ? assignment
    : undefined;
}

export function createUltraMaxModelExposureRecorder({
  posthog,
  assignment,
  userId,
  mode,
  subscription,
  requestId,
}: {
  posthog: Pick<PostHog, "capture"> | null;
  assignment: UltraMaxModelAssignment | undefined;
  userId: string;
  mode: ChatMode;
  subscription: SubscriptionTier;
  requestId: string;
}): (configuredModel: string) => void {
  let recorded = false;
  return (configuredModel) => {
    if (
      recorded ||
      !posthog ||
      !assignment ||
      configuredModel !== assignment.configuredModel
    )
      return;

    recorded = true;
    try {
      posthog.capture({
        distinctId: userId,
        event: ULTRA_MAX_MODEL_EXPOSURE_EVENT,
        properties: {
          ...getExperimentAnalyticsProperties(assignment),
          subscription,
          subscription_tier: subscription,
          mode,
          selected_model: assignment.modelKey,
          configured_model: configuredModel,
          request_id: requestId,
          exposure_surface: "provider_request",
          $process_person_profile: false,
        },
      });
    } catch {
      // An analytics failure must not interrupt a provider request.
    }
  };
}
