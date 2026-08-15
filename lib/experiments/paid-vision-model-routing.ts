import type { PostHog } from "posthog-node";
import type { ModelName } from "@/lib/ai/providers";
import type { ExperimentAnalyticsContext } from "@/lib/analytics/experiment-context";
import type { ChatMode, SelectedModel, SubscriptionTier } from "@/types";

export const PAID_VISION_MODEL_ROUTING_EXPERIMENT_KEY =
  "paid_vision_model_routing_v1";
export const PAID_VISION_MODEL_ROUTING_EXPOSURE_EVENT =
  "paid_vision_model_routing_experiment_exposed";
export const PAID_VISION_MODEL_ROUTING_FEATURE_PROPERTY = `$feature/${PAID_VISION_MODEL_ROUTING_EXPERIMENT_KEY}`;

export type PaidVisionModelRoutingVariant = "control" | "test";
export type PaidVisionTier = "auto_standard" | "pro";
export type PaidVisionModelKey =
  "model-grok-4.6" | "model-grok-4.5" | "model-grok-4.5-pro";

export type PaidVisionModelRoutingAssignment = {
  key: typeof PAID_VISION_MODEL_ROUTING_EXPERIMENT_KEY;
  variant: PaidVisionModelRoutingVariant;
  visionTier: PaidVisionTier;
  modelKey: PaidVisionModelKey;
  reasoningEffort: "medium" | "high";
};

const PAID_TEXT_MODEL_KEYS = new Set<ModelName>([
  "model-deepseek-v4-flash-0731",
  "model-deepseek-v4-pro",
  "model-deepseek-v4-pro-0813",
]);

export function getPaidVisionTier(
  subscription: SubscriptionTier,
  selectedModelOverride?: SelectedModel,
): PaidVisionTier | undefined {
  if (subscription === "free" || selectedModelOverride === "hackerai-max") {
    return undefined;
  }
  return selectedModelOverride === "hackerai-pro" ? "pro" : "auto_standard";
}

export async function evaluatePaidVisionModelRoutingExperiment({
  posthog,
  userId,
  subscription,
  selectedModelOverride,
  requestId,
}: {
  posthog: Pick<PostHog, "evaluateFlags"> | null;
  userId: string;
  subscription: SubscriptionTier;
  selectedModelOverride?: SelectedModel;
  requestId?: string;
}): Promise<PaidVisionModelRoutingAssignment | undefined> {
  const visionTier = getPaidVisionTier(subscription, selectedModelOverride);
  if (!posthog || !visionTier) return undefined;

  try {
    const flags = await posthog.evaluateFlags(userId, {
      flagKeys: [PAID_VISION_MODEL_ROUTING_EXPERIMENT_KEY],
    });
    const variant = flags.getFlag(PAID_VISION_MODEL_ROUTING_EXPERIMENT_KEY);
    if (variant !== "control" && variant !== "test") return undefined;

    const isPro = visionTier === "pro";
    return {
      key: PAID_VISION_MODEL_ROUTING_EXPERIMENT_KEY,
      variant,
      visionTier,
      modelKey:
        variant === "control"
          ? "model-grok-4.6"
          : isPro
            ? "model-grok-4.5-pro"
            : "model-grok-4.5",
      reasoningEffort: variant === "test" && !isPro ? "medium" : "high",
    };
  } catch (error) {
    console.warn(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "warn",
        event: "paid_vision_model_routing_experiment_evaluation_failed",
        service: "model-routing-experiment",
        environment:
          process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
        request_id: requestId ?? "unavailable",
        user_id: userId,
        flag_key: PAID_VISION_MODEL_ROUTING_EXPERIMENT_KEY,
        error_name: error instanceof Error ? error.name : "UnknownError",
      }),
    );
    return undefined;
  }
}

export function getActivePaidVisionModelRoutingAssignment(
  assignment: PaidVisionModelRoutingAssignment | undefined,
  selectedModel: ModelName,
): PaidVisionModelRoutingAssignment | undefined {
  if (!assignment) return undefined;
  return assignment.modelKey === selectedModel ||
    PAID_TEXT_MODEL_KEYS.has(selectedModel)
    ? assignment
    : undefined;
}

export function capturePaidVisionModelRoutingExposure({
  posthog,
  userId,
  subscription,
  mode,
  selectedModelOverride,
  configuredModel,
  exposureSurface,
  assignment,
}: {
  posthog: Pick<PostHog, "capture"> | null;
  userId: string;
  subscription: SubscriptionTier;
  mode: ChatMode;
  selectedModelOverride?: SelectedModel;
  configuredModel: string;
  exposureSurface: "image_attachment" | "agent_image_tool_result";
  assignment?: PaidVisionModelRoutingAssignment;
}): void {
  if (!posthog || !assignment) return;

  posthog.capture({
    distinctId: userId,
    event: PAID_VISION_MODEL_ROUTING_EXPOSURE_EVENT,
    properties: {
      experiment_key: assignment.key,
      experiment_variant: assignment.variant,
      [PAID_VISION_MODEL_ROUTING_FEATURE_PROPERTY]: assignment.variant,
      subscription_tier: subscription,
      mode,
      selected_model_override: selectedModelOverride ?? "auto",
      vision_tier: assignment.visionTier,
      configured_model: configuredModel,
      reasoning_effort: assignment.reasoningEffort,
      exposure_surface: exposureSurface,
      $process_person_profile: false,
    },
  });
}

export function getPaidVisionModelRoutingExperimentContext(
  assignment: PaidVisionModelRoutingAssignment | undefined,
): ExperimentAnalyticsContext | undefined {
  if (!assignment) return undefined;
  return { key: assignment.key, variant: assignment.variant };
}
