import { getPostHogFeatureFlagVariantForUser } from "@/lib/posthog/server";
import type { ChatMode, SelectedModel, SubscriptionTier } from "@/types";

export const AGENT_MODEL_CONTEXT_FLAG = "agent_model_context_v1";

export type AgentModelContextVariant = "control" | "test";

/** Resolve once before history loading; unknown decisions stay unassigned. */
export async function getAgentModelContextVariant(
  userId: string,
  subscription: SubscriptionTier,
  mode: ChatMode,
  selectedModel?: SelectedModel,
): Promise<AgentModelContextVariant | undefined> {
  if (
    mode !== "agent" ||
    selectedModel !== "hackerai-max" ||
    subscription === "free"
  )
    return undefined;
  const variant = await getPostHogFeatureFlagVariantForUser(
    AGENT_MODEL_CONTEXT_FLAG,
    userId,
    {
      personProperties: {
        subscription_tier: subscription,
        mode,
        selected_model: selectedModel,
      },
      sendFeatureFlagEvents: false,
    },
  );
  return variant === "control" || variant === "test" ? variant : undefined;
}

/** Boolean adapter for callers that do not emit experiment exposures. */
export async function isAgentModelContextEnabled(
  userId: string,
  subscription: SubscriptionTier,
  mode: ChatMode,
  selectedModel?: SelectedModel,
): Promise<boolean> {
  return (
    (await getAgentModelContextVariant(
      userId,
      subscription,
      mode,
      selectedModel,
    )) === "test"
  );
}
