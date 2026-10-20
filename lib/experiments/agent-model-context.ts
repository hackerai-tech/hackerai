import { getPostHogFeatureFlagVariantForUser } from "@/lib/posthog/server";
import type { ChatMode, SelectedModel, SubscriptionTier } from "@/types";

export const AGENT_MODEL_CONTEXT_FLAG = "agent_model_context_v1";

export const PRO_AGENT_MODEL_CONTEXT_FLAG = "agent_pro_context_v1";
export type AgentModelContextFlag =
  typeof AGENT_MODEL_CONTEXT_FLAG | typeof PRO_AGENT_MODEL_CONTEXT_FLAG;

/** Keep Pro assignment and analytics independent from the existing Max trial. */
export function getAgentModelContextFlag(
  selectedModel?: SelectedModel,
): AgentModelContextFlag | undefined {
  if (selectedModel === "hackerai-max") return AGENT_MODEL_CONTEXT_FLAG;
  if (selectedModel === "hackerai-pro") return PRO_AGENT_MODEL_CONTEXT_FLAG;
  return undefined;
}

export type AgentModelContextVariant = "control" | "test";

/** Resolve once before history loading; unknown decisions stay unassigned. */
export async function getAgentModelContextVariant(
  userId: string,
  subscription: SubscriptionTier,
  mode: ChatMode,
  selectedModel?: SelectedModel,
): Promise<AgentModelContextVariant | undefined> {
  const flag = getAgentModelContextFlag(selectedModel);
  if (mode !== "agent" || !selectedModel || !flag || subscription === "free")
    return undefined;
  const variant = await getPostHogFeatureFlagVariantForUser(flag, userId, {
    personProperties: {
      subscription_tier: subscription,
      mode,
      selected_model: selectedModel,
    },
    sendFeatureFlagEvents: false,
  });
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
