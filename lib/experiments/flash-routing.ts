import type { PostHog } from "posthog-node";
import type { ModelName } from "@/lib/ai/providers";
import { getExperimentAnalyticsProperties } from "@/lib/analytics/experiment-context";
import type { ChatMode, SubscriptionTier } from "@/types";
import {
  evaluateFreeAskDeepSeek1017,
  FREE_ASK_DEEPSEEK_1017_KEY,
} from "./free-ask-deepseek-1017";

export const FLASH_ROUTING_EXPOSURE_EVENT = "flash_routing_experiment_exposed";

export type FlashRoutingAssignment = {
  key: typeof FREE_ASK_DEEPSEEK_1017_KEY;
  variant: "control" | "test";
  modelKey: ModelName;
  configuredModel: string;
};

/** Enroll only the authenticated tier's existing eligible baseline route. */
export async function evaluateFlashRouting({
  posthog,
  userId,
  mode,
  subscription,
  selectedModel,
  hasImages,
  limitRescue = false,
  modelPolicyActive = false,
}: {
  posthog: Pick<PostHog, "evaluateFlags" | "getFeatureFlagResult"> | null;
  userId: string;
  mode: ChatMode;
  subscription: SubscriptionTier;
  selectedModel: ModelName;
  hasImages: boolean;
  limitRescue?: boolean;
  modelPolicyActive?: boolean;
}): Promise<FlashRoutingAssignment | undefined> {
  if (!posthog || !userId || limitRescue || modelPolicyActive) return undefined;
  if (hasImages) return undefined;
  if (
    mode === "ask" &&
    subscription === "free" &&
    selectedModel === "ask-model-free-glm"
  ) {
    try {
      return await evaluateFreeAskDeepSeek1017(posthog, userId);
    } catch {
      return undefined;
    }
  }
  return undefined;
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
          message_id: requestId,
          exposure_surface: "provider_request",
          ...(assignment.key === FREE_ASK_DEEPSEEK_1017_KEY && {
            $insert_id: `${requestId}:free-ask-1017-exposure`,
          }),
          $process_person_profile: false,
        },
      });
    } catch {
      // An analytics failure must not interrupt a provider request.
    }
  };
}
