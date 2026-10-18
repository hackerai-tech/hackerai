import { getPostHogBooleanFlagDecisionForUser } from "@/lib/posthog/server";
import type { ChatMode, SelectedModel, SubscriptionTier } from "@/types";

export const AGENT_MODEL_CONTEXT_FLAG = "agent_model_context_v1";

/** Resolve once before history loading; reuse across provider retries. */
export async function isAgentModelContextEnabled(
  userId: string,
  subscription: SubscriptionTier,
  mode: ChatMode,
  selectedModel?: SelectedModel,
): Promise<boolean> {
  if (
    mode !== "agent" ||
    selectedModel !== "hackerai-max" ||
    subscription === "free"
  )
    return false;
  return (
    (await getPostHogBooleanFlagDecisionForUser(
      AGENT_MODEL_CONTEXT_FLAG,
      userId,
      { subscription_tier: subscription, mode, selected_model: selectedModel },
      { sendFeatureFlagEvents: false },
    )) === true
  );
}
