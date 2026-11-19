import { MAX_OUTPUT_TOKENS } from "./output-limits";
import { getMaxTokensForSubscription } from "@/lib/token-limits";
import { isExpandedAgentContextEligible } from "@/lib/experiments/agent-model-context";
import type { ChatMode, SelectedModel, SubscriptionTier } from "@/types";

/**
 * Context policy for one top-level Agent run. Resolve it once at entry and use
 * it for history loading, message preparation, provider requests, retries and
 * compaction so those stages cannot disagree about the budget.
 *
 * - `baseline`: the subscription budget (276K paid, 256K before compaction).
 * - `expanded`: permanent explicit Pro/Max policy (route half-window).
 * - `paid_480k`: paid Auto/Standard policy (480K compaction trigger).
 */
export type AgentContextPolicy = "baseline" | "expanded" | "paid_480k";

const isPaidSubscription = (subscription: SubscriptionTier) =>
  subscription === "pro" ||
  subscription === "pro-plus" ||
  subscription === "ultra" ||
  subscription === "team";

/**
 * The single policy decision for a top-level Agent run. Subagents do not call
 * this: their records carry a routed model key rather than the parent selector.
 */
export function getAgentContextPolicy({
  subscription,
  mode,
  selectedModelOverride,
}: {
  subscription: SubscriptionTier;
  mode: ChatMode;
  selectedModelOverride: SelectedModel | undefined;
}): AgentContextPolicy {
  if (isExpandedAgentContextEligible(subscription, mode, selectedModelOverride))
    return "expanded";
  return mode === "agent" &&
    isPaidSubscription(subscription) &&
    (selectedModelOverride === undefined ||
      selectedModelOverride === "auto" ||
      selectedModelOverride === "hackerai-standard")
    ? "paid_480k"
    : "baseline";
}

// Conservative operating budget, inspired by Hermes's half-window default.
// The existing compaction reserve is applied on top of this budget. This is
// not a promise that the independent serialized-byte guard will allow it all.
export const MAX_AGENT_CONTEXT_TOKENS = Math.floor(
  (1_048_576 - MAX_OUTPUT_TOKENS) * 0.5,
);

// Paid Auto/Standard target: compaction triggers at exactly 480K after the existing 20K
// reserve. It is capped by verified route capacity minus the output reserve and
// deliberately does not use the half-window heuristic above.
export const PAID_AGENT_CONTEXT_MAX_TOKENS = 500_000;

// Verified against https://openrouter.ai/api/v1/models on 2026-10-18.
// Use the smaller advertised top_provider.context_length where it differs.
// Exact IDs deliberately fail closed for new models and custom endpoints.
// Abliteration capacities verified at docs.abliteration.ai/models (2026-10-23).
// Old raw IDs retain their limits; active registry aliases execute Large Flash.
const MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  "deepseek-v4.1-flash-1017-cyber": 1_040_000,
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

/** Smallest verified capacity across a route, or undefined if any is unknown. */
function getVerifiedRouteCapacity(
  modelId: string,
  fallbackModelIds: readonly string[],
): number | undefined {
  const capacities = [modelId, ...fallbackModelIds].map((id) =>
    Object.hasOwn(MODEL_CONTEXT_WINDOWS, id)
      ? MODEL_CONTEXT_WINDOWS[id]
      : undefined,
  );
  if (!capacities.every((capacity) => capacity !== undefined)) return undefined;
  return Math.min(...capacities);
}

const appliesToRun = (
  policy: AgentContextPolicy,
  mode: ChatMode | undefined,
  subscription: SubscriptionTier | undefined,
): boolean =>
  mode === "agent" &&
  (policy === "expanded" ||
    (policy === "paid_480k" &&
      subscription !== undefined &&
      subscription !== "free"));

export function getAgentContextBudget({
  policy,
  enabled,
  mode,
  subscription,
  modelId,
  fallbackModelIds = [],
}: {
  policy?: AgentContextPolicy;
  /** Shorthand for the `expanded` policy, retained for existing callers. */
  enabled?: boolean;
  mode?: ChatMode;
  subscription?: SubscriptionTier;
  modelId: string;
  fallbackModelIds?: readonly string[];
}): number {
  const baseline = getMaxTokensForSubscription(subscription, { mode });
  const resolved = policy ?? (enabled ? "expanded" : "baseline");
  if (!appliesToRun(resolved, mode, subscription)) return baseline;
  // OpenRouter may transparently serve any route member. Budget for the
  // smallest member before sending, rather than learning about it on overflow.
  const capacity = getVerifiedRouteCapacity(modelId, fallbackModelIds);
  if (capacity === undefined) return baseline;
  const usable = capacity - MAX_OUTPUT_TOKENS;
  return resolved === "paid_480k"
    ? Math.min(PAID_AGENT_CONTEXT_MAX_TOKENS, usable)
    : Math.min(MAX_AGENT_CONTEXT_TOKENS, Math.floor(usable * 0.5));
}

/** Load enough history before routing; prepareStep enforces the actual model. */
export function getAgentHistoryBudget(
  subscription: SubscriptionTier,
  mode: ChatMode | undefined,
  policy: AgentContextPolicy = "baseline",
): number {
  if (!appliesToRun(policy, mode, subscription))
    return getMaxTokensForSubscription(subscription, { mode });
  return policy === "paid_480k"
    ? PAID_AGENT_CONTEXT_MAX_TOKENS
    : MAX_AGENT_CONTEXT_TOKENS;
}
