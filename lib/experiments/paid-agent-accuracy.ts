import type { PostHog } from "posthog-node";
import type { ModelName } from "@/lib/ai/providers";
import { DEEPSEEK_1017_MODEL_KEY } from "./paid-deepseek-1017";
import type { ChatMode, SelectedModel, SubscriptionTier } from "@/types";

export const PAID_AGENT_ACCURACY_KEY = "paid_agent_accuracy_grok_v1";
export const PAID_AGENT_ACCURACY_MODEL = "model-grok-4.6" as const;
export const PAID_AGENT_ACCURACY_EXPOSED = "paid_agent_accuracy_exposed";

/** Resolve before admission so the selected model's cost and context limits apply. */
export async function evaluatePaidAgentAccuracy({
  posthog,
  userId,
  mode,
  subscription,
  selectedModel,
  selectedModelOverride,
  hasAttachments,
  limitRescue = false,
  modelPolicyActive = false,
}: {
  posthog: Pick<PostHog, "evaluateFlags"> | null;
  userId: string;
  mode: ChatMode;
  subscription: SubscriptionTier;
  selectedModel: ModelName;
  selectedModelOverride?: SelectedModel;
  hasAttachments: boolean;
  limitRescue?: boolean;
  modelPolicyActive?: boolean;
}): Promise<typeof PAID_AGENT_ACCURACY_MODEL | undefined> {
  if (
    !posthog ||
    !userId ||
    mode !== "agent" ||
    !["pro", "pro-plus", "ultra", "team"].includes(subscription) ||
    !["auto", "hackerai-standard", "hackerai-pro"].includes(
      selectedModelOverride ?? "auto",
    ) ||
    selectedModel !== DEEPSEEK_1017_MODEL_KEY ||
    hasAttachments ||
    limitRescue ||
    modelPolicyActive
  )
    return;
  try {
    const flags = await posthog.evaluateFlags(userId, {
      flagKeys: [PAID_AGENT_ACCURACY_KEY],
    });
    if (flags.getFlag(PAID_AGENT_ACCURACY_KEY) === true)
      return PAID_AGENT_ACCURACY_MODEL;
  } catch {
    // A flag outage retains the admitted baseline rather than blocking chat.
  }
}

/** Record actual candidate dispatch once, after later rescue decisions have settled. */
export function createPaidAgentAccuracyExposureRecorder({
  posthog,
  enabled,
  selectedModel,
  userId,
  subscription,
  selectedModelOverride,
  requestId,
}: {
  posthog: Pick<PostHog, "capture"> | null;
  enabled: boolean;
  selectedModel: ModelName;
  userId: string;
  subscription: SubscriptionTier;
  selectedModelOverride?: SelectedModel;
  requestId: string;
}): (configuredModel: string) => void {
  let recorded = false;
  return (configuredModel) => {
    if (
      recorded ||
      !enabled ||
      !posthog ||
      selectedModel !== PAID_AGENT_ACCURACY_MODEL ||
      configuredModel !== "x-ai/grok-4.6"
    )
      return;
    recorded = true;
    try {
      posthog.capture({
        distinctId: userId,
        event: PAID_AGENT_ACCURACY_EXPOSED,
        properties: {
          flag_key: PAID_AGENT_ACCURACY_KEY,
          flag_enabled: true,
          [`$feature/${PAID_AGENT_ACCURACY_KEY}`]: true,
          mode: "agent",
          subscription_tier: subscription,
          selector: selectedModelOverride ?? "auto",
          selected_model: selectedModel,
          configured_model: configuredModel,
          request_id: requestId,
          message_id: requestId,
          exposure_surface: "provider_request",
          $insert_id: `${requestId}:paid-agent-accuracy`,
          $process_person_profile: false,
        },
      });
    } catch {
      // Reporting cannot interrupt generation or billing.
    }
  };
}
