import type { ChatMode, SelectedModel, SubscriptionTier } from "@/types";

export const AGENT_MODEL_CONTEXT_FLAG = "agent_model_context_v1";

export const PRO_AGENT_MODEL_CONTEXT_FLAG = "agent_pro_context_v1";
export type AgentModelContextFlag =
  typeof AGENT_MODEL_CONTEXT_FLAG | typeof PRO_AGENT_MODEL_CONTEXT_FLAG;

/** Retain tier-specific keys for historical analytics and feedback records. */
export function getAgentModelContextFlag(
  selectedModel?: SelectedModel,
): AgentModelContextFlag | undefined {
  if (selectedModel === "hackerai-max") return AGENT_MODEL_CONTEXT_FLAG;
  if (selectedModel === "hackerai-pro") return PRO_AGENT_MODEL_CONTEXT_FLAG;
  return undefined;
}

export type AgentModelContextVariant = "control" | "test";

/** Expanded context is permanent for the existing paid explicit Agent population. */
export function isExpandedAgentContextEligible(
  subscription: SubscriptionTier,
  mode: ChatMode,
  selectedModel?: SelectedModel,
): boolean {
  return (
    mode === "agent" &&
    (subscription === "pro" ||
      subscription === "pro-plus" ||
      subscription === "ultra" ||
      subscription === "team") &&
    (selectedModel === "hackerai-max" || selectedModel === "hackerai-pro")
  );
}
