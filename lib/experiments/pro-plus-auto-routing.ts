import type { PostHog } from "posthog-node";
import type { ModelName } from "@/lib/ai/providers";
import { getExperimentAnalyticsProperties } from "@/lib/analytics/experiment-context";
import type { ChatMode, SelectedModel, SubscriptionTier } from "@/types";

export const PRO_PLUS_AUTO_ROUTING_KEY = "pro_plus_auto_deepseek_v41_flash_v1";
export const PRO_PLUS_AUTO_EXPOSURE_EVENT =
  "pro_plus_auto_deepseek_v41_flash_exposed";

export type ProPlusAutoRoutingAssignment = {
  key: typeof PRO_PLUS_AUTO_ROUTING_KEY;
  variant: "control" | "test";
  modelKey: ModelName;
  configuredModel: string;
};

/** Only promote Pro+ Auto text/PDF requests after the normal plan/media gates. */
export async function evaluateProPlusAutoRouting({
  posthog,
  userId,
  subscription,
  selectedModelOverride,
  selectedModel,
  hasImages,
  limitRescue,
}: {
  posthog: Pick<PostHog, "evaluateFlags"> | null;
  userId: string;
  subscription: SubscriptionTier;
  selectedModelOverride?: SelectedModel;
  selectedModel: ModelName;
  hasImages: boolean;
  limitRescue: boolean;
}): Promise<ProPlusAutoRoutingAssignment | undefined> {
  if (
    !posthog ||
    !userId ||
    subscription !== "pro-plus" ||
    (selectedModelOverride && selectedModelOverride !== "auto") ||
    selectedModel !== "model-deepseek-v4-flash-0731" ||
    hasImages ||
    limitRescue
  )
    return undefined;

  try {
    const flags = await posthog.evaluateFlags(userId, {
      flagKeys: [PRO_PLUS_AUTO_ROUTING_KEY],
      personProperties: { subscription_tier: subscription },
    });
    const enabled = flags.getFlag(PRO_PLUS_AUTO_ROUTING_KEY);
    if (typeof enabled !== "boolean") return undefined;
    return {
      key: PRO_PLUS_AUTO_ROUTING_KEY,
      variant: enabled ? "test" : "control",
      modelKey: enabled ? "model-deepseek-v4-flash-vision-pro" : selectedModel,
      configuredModel: enabled
        ? "deepseek/deepseek-v4.1-flash"
        : "deepseek/deepseek-v4-flash-0731",
    };
  } catch {
    // Analytics availability must never make chat unavailable.
    return undefined;
  }
}

export function getActiveProPlusAutoRoutingAssignment(
  assignment: ProPlusAutoRoutingAssignment | undefined,
  selectedModel: ModelName,
  isPaidAllowanceRescue: boolean,
): ProPlusAutoRoutingAssignment | undefined {
  return !isPaidAllowanceRescue && assignment?.modelKey === selectedModel
    ? assignment
    : undefined;
}

/** Record once, only when the assigned model actually receives a request. */
export function createProPlusAutoExposureRecorder({
  posthog,
  assignment,
  userId,
  mode,
  requestId,
}: {
  posthog: Pick<PostHog, "capture"> | null;
  assignment: ProPlusAutoRoutingAssignment | undefined;
  userId: string;
  mode: ChatMode;
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
        event: PRO_PLUS_AUTO_EXPOSURE_EVENT,
        properties: {
          ...getExperimentAnalyticsProperties(assignment),
          [`$feature/${PRO_PLUS_AUTO_ROUTING_KEY}`]:
            assignment.variant === "test",
          subscription_tier: "pro-plus",
          mode,
          selected_model: assignment.modelKey,
          configured_model: configuredModel,
          request_id: requestId,
          exposure_surface: "provider_request",
          $process_person_profile: false,
        },
      });
    } catch {
      // Telemetry must not interrupt a provider request.
    }
  };
}
