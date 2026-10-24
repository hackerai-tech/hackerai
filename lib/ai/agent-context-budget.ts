import { MAX_OUTPUT_TOKENS } from "./output-limits";
import { getMaxTokensForSubscription } from "@/lib/token-limits";
import type { ChatMode, SubscriptionTier } from "@/types";

// Conservative operating budget, inspired by Hermes's half-window default.
// The existing compaction reserve is applied on top of this budget. This is
// not a promise that the independent serialized-byte guard will allow it all.
export const MAX_AGENT_CONTEXT_TOKENS = Math.floor(
  (1_048_576 - MAX_OUTPUT_TOKENS) * 0.5,
);

// Verified against https://openrouter.ai/api/v1/models on 2026-10-18.
// Use the smaller advertised top_provider.context_length where it differs.
// Exact IDs deliberately fail closed for new models and custom endpoints.
// Abliteration capacities verified at docs.abliteration.ai/models (2026-10-23).
// Old raw IDs retain their limits; active registry aliases execute Large Flash.
const MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  "abliterated-model-large-flash": 1_048_576,
  "abliterated-model-large-v2": 1_000_000,
  "deepseek/deepseek-v4.1-flash": 1_048_576,
  "deepseek/deepseek-v4.1-flash-1017": 1_048_576,
  "deepseek/deepseek-v4.1-flash-20261017": 1_048_576,
  "deepseek/deepseek-v4-flash": 1_048_575,
  "deepseek/deepseek-v4-pro": 1_024_000,
  "deepseek/deepseek-v4-pro-0813": 1_024_000,
  "z-ai/glm-5.2": 1_048_576,
  "z-ai/glm-5.3": 1_048_576,
  "z-ai/glm-5.3-flash": 1_048_576,
  "moonshotai/kimi-k3": 1_048_576,
  "x-ai/grok-4.5": 500_000,
  "x-ai/grok-4.6": 500_000,
};

export function getAgentContextBudget({
  enabled,
  mode,
  subscription,
  modelId,
  fallbackModelIds = [],
}: {
  enabled?: boolean;
  mode?: ChatMode;
  subscription?: SubscriptionTier;
  modelId: string;
  fallbackModelIds?: readonly string[];
}): number {
  const baseline = getMaxTokensForSubscription(subscription, { mode });
  if (!enabled || mode !== "agent") return baseline;
  const capacities = [modelId, ...fallbackModelIds].map((id) =>
    Object.hasOwn(MODEL_CONTEXT_WINDOWS, id)
      ? MODEL_CONTEXT_WINDOWS[id]
      : undefined,
  );
  if (!capacities.every((capacity) => capacity !== undefined)) return baseline;
  // OpenRouter may transparently serve any route member. Budget for the
  // smallest member before sending, rather than learning about it on overflow.
  return Math.min(
    MAX_AGENT_CONTEXT_TOKENS,
    Math.floor((Math.min(...capacities) - MAX_OUTPUT_TOKENS) * 0.5),
  );
}

/** Load enough history before routing; prepareStep enforces the actual model. */
export function getAgentHistoryBudget(
  subscription: SubscriptionTier,
  mode: ChatMode | undefined,
  enabled = false,
): number {
  return mode === "agent" && enabled
    ? MAX_AGENT_CONTEXT_TOKENS
    : getMaxTokensForSubscription(subscription, { mode });
}
