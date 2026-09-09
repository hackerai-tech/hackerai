import type { PostHog } from "posthog-node";
import type { ModelName } from "@/lib/ai/providers";
import { getExperimentAnalyticsProperties } from "@/lib/analytics/experiment-context";
import type { ChatMode, SubscriptionTier } from "@/types";

export const PAID_AGENT_FLASH_RETURN_KEY = "paid_agent_glm_flash_return_v1";
export const FLASH_ROUTING_EXPOSURE_EVENT = "flash_routing_experiment_exposed";

export type FlashRoutingAssignment = {
  key: typeof PAID_AGENT_FLASH_RETURN_KEY;
  variant: "control" | "test";
  modelKey: ModelName;
  configuredModel: string;
};

/** Only paid Agent standard routes participate; free Ask uses a fixed model. */
export async function evaluateFlashRouting({
  posthog,
  userId,
  mode,
  subscription,
  selectedModel,
  hasImages,
}: {
  posthog: Pick<PostHog, "evaluateFlags"> | null;
  userId: string;
  mode: ChatMode;
  subscription: SubscriptionTier;
  selectedModel: ModelName;
  hasImages: boolean;
}): Promise<FlashRoutingAssignment | undefined> {
  if (!posthog || !userId || hasImages) return undefined;
  const key =
    mode === "agent" &&
    subscription !== "free" &&
    selectedModel === "model-deepseek-v4-flash-0731"
      ? PAID_AGENT_FLASH_RETURN_KEY
      : undefined;
  if (!key) return undefined;

  try {
    const flags = await posthog.evaluateFlags(userId, { flagKeys: [key] });
    const variant = flags.getFlag(key);
    if (variant !== "control" && variant !== "test") return undefined;
    return {
      key,
      variant,
      modelKey:
        variant === "control" ? selectedModel : "model-glm-5.3-flash-agent",
      configuredModel:
        variant === "test"
          ? "z-ai/glm-5.3-flash"
          : "deepseek/deepseek-v4-flash-0731",
    };
  } catch {
    // Analytics availability must never make chat unavailable or change the default.
    return undefined;
  }
}

/** Drop assignments superseded by rescue or another routing decision. */
export function getActiveFlashRoutingAssignment(
  assignment: FlashRoutingAssignment | undefined,
  selectedModel: ModelName,
  isPaidAllowanceRescue: boolean,
): FlashRoutingAssignment | undefined {
  return !isPaidAllowanceRescue && assignment?.modelKey === selectedModel
    ? assignment
    : undefined;
}

/** A request-scoped callback: assignment alone is not model exposure. */
export function createFlashRoutingExposureRecorder({
  posthog,
  assignment,
  userId,
  mode,
  subscription,
  requestId,
}: {
  posthog: Pick<PostHog, "capture"> | null;
  assignment: FlashRoutingAssignment | undefined;
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
        event: FLASH_ROUTING_EXPOSURE_EVENT,
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
