import {
  PAID_DEEPSEEK_1017_KEY,
  DEEPSEEK_1017_MODEL_KEY,
  DEEPSEEK_1017_SLUG,
} from "./paid-deepseek-1017";
import { getPostHogFlagWithoutExposure } from "@/lib/posthog/flag-assignment";
import type { PostHog } from "posthog-node";
import { myProvider, type ModelName } from "@/lib/ai/providers";
import { getExperimentAnalyticsProperties } from "@/lib/analytics/experiment-context";
import type { ChatMode, SubscriptionTier, SelectedModel } from "@/types";

export const PAID_AGENT_FLASH_RETURN_KEY = "paid_agent_glm_flash_return_v1";
export const FLASH_ROUTING_EXPOSURE_EVENT = "flash_routing_experiment_exposed";

export type FlashRoutingAssignment = {
  key: typeof PAID_AGENT_FLASH_RETURN_KEY | typeof PAID_DEEPSEEK_1017_KEY;
  requestId?: string;
  startedAt?: number;
  baselineModel?: string;
  selectedModelOverride?: string;
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
  selectedModelOverride,
  limitRescue = false,
  modelPolicyActive = false,
}: {
  posthog: Pick<PostHog, "evaluateFlags" | "getFeatureFlagResult"> | null;
  userId: string;
  mode: ChatMode;
  subscription: SubscriptionTier;
  selectedModel: ModelName;
  hasImages: boolean;
  selectedModelOverride?: SelectedModel;
  limitRescue?: boolean;
  modelPolicyActive?: boolean;
}): Promise<FlashRoutingAssignment | undefined> {
  if (!posthog || !userId || limitRescue || modelPolicyActive) return undefined;
  const selector = selectedModelOverride ?? "auto";
  const paidEligible =
    ["pro", "pro-plus", "ultra", "team"].includes(subscription) &&
    (selector === "auto" || selector === "hackerai-pro") &&
    [
      "model-deepseek-v4-flash-vision-pro",
      "model-deepseek-v4-flash-vision",
      "model-glm-5.3-flash",
      "model-grok-4.5",
    ].includes(selectedModel);
  if (paidEligible) {
    try {
      const variant = await getPostHogFlagWithoutExposure(
        posthog,
        PAID_DEEPSEEK_1017_KEY,
        userId,
        {
          subscription_tier: subscription,
        },
      );
      if (variant !== "control" && variant !== "test") return undefined;
      return {
        key: PAID_DEEPSEEK_1017_KEY,
        variant,
        modelKey: variant === "test" ? DEEPSEEK_1017_MODEL_KEY : selectedModel,
        configuredModel:
          variant === "test"
            ? DEEPSEEK_1017_SLUG
            : myProvider.languageModel(selectedModel).modelId,
        baselineModel: selectedModel,
        selectedModelOverride: selector,
        startedAt: Date.now(),
      };
    } catch {
      return undefined;
    }
  }
  if (hasImages) return undefined;
  const key =
    mode === "agent" &&
    subscription !== "free" &&
    selectedModel === "model-deepseek-v4-flash-0731"
      ? PAID_AGENT_FLASH_RETURN_KEY
      : undefined;
  if (!key) return undefined;
  // This legacy experiment compares 0731 with GLM. Redirected saved selections
  // must not enroll a different baseline under its historical experiment key.
  if (
    myProvider.languageModel(selectedModel).modelId !==
    "deepseek/deepseek-v4-flash-0731"
  ) {
    return undefined;
  }

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
  controlContinuationModel,
}: {
  posthog: Pick<PostHog, "capture"> | null;
  assignment: FlashRoutingAssignment | undefined;
  userId: string;
  mode: ChatMode;
  subscription: SubscriptionTier;
  requestId: string;
  /** The normal post-compaction route, resolved by the shared runner policy. */
  controlContinuationModel?: string;
}): (configuredModel: string) => void {
  let recorded = false;
  return (configuredModel) => {
    const isControlContinuation =
      assignment?.key === PAID_DEEPSEEK_1017_KEY &&
      assignment.variant === "control" &&
      mode === "agent" &&
      configuredModel === controlContinuationModel;
    if (
      recorded ||
      !posthog ||
      !assignment ||
      (configuredModel !== assignment.configuredModel && !isControlContinuation)
    )
      return;
    recorded = true;
    if (assignment.key === PAID_DEEPSEEK_1017_KEY)
      assignment.requestId = requestId;
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
          ...(isControlContinuation && {
            assigned_configured_model: assignment.configuredModel,
          }),
          request_id: requestId,
          message_id: requestId,
          baseline_model: assignment.baselineModel,
          selected_model_override: assignment.selectedModelOverride,
          exposure_surface: "provider_request",
          $process_person_profile: false,
        },
      });
    } catch {
      // An analytics failure must not interrupt a provider request.
    }
  };
}
