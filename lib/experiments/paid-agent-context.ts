import type { PostHog } from "posthog-node";
import { v5 as uuidv5 } from "uuid";
import {
  getAgentContextBudget,
  PAID_AGENT_CONTEXT_MAX_TOKENS,
  type AgentContextPolicy,
} from "@/lib/ai/agent-context-budget";
import { getSummarizationThresholdTokens } from "@/lib/chat/summarization/constants";
import { getPostHogFlagWithoutExposure } from "@/lib/posthog/flag-assignment";
import { isExpandedAgentContextEligible } from "./agent-model-context";
import type { ChatMode, SelectedModel, SubscriptionTier } from "@/types";

export const PAID_AGENT_CONTEXT_FLAG = "paid_agent_context_480k_v1";
export const PAID_AGENT_CONTEXT_EXPOSURE_EVENT = "agent_model_context_exposed";

export type PaidAgentContextVariant = "control" | "test";
export type PaidAgentContextSelection = "auto" | "hackerai-standard";

export type PaidAgentContextExposure = {
  modelId: string;
  contextMaxTokens: number;
  compactionThresholdTokens: number;
  /** The treatment policy reaches the 480K trigger on this route. */
  routeSupports480k: boolean;
};

/**
 * Run-scoped assignment snapshot. Resolved once per top-level Agent run and
 * threaded through retries; it is never persisted into subagent records.
 */
export type PaidAgentContextAssignment = {
  readonly flagKey: typeof PAID_AGENT_CONTEXT_FLAG;
  readonly variant: PaidAgentContextVariant;
  readonly requestedSelection: PaidAgentContextSelection;
  /** Set once, when the first real model request of the run starts. */
  exposure?: PaidAgentContextExposure;
};

/** Eligible selector for paid Agent Auto/Standard; explicit Pro/Max excluded. */
export function getPaidAgentContextSelection(
  subscription: SubscriptionTier,
  mode: ChatMode,
  selectedModelOverride: SelectedModel | undefined,
): PaidAgentContextSelection | undefined {
  if (mode !== "agent") return undefined;
  if (
    subscription !== "pro" &&
    subscription !== "pro-plus" &&
    subscription !== "ultra" &&
    subscription !== "team"
  )
    return undefined;
  if (selectedModelOverride === undefined || selectedModelOverride === "auto")
    return "auto";
  return selectedModelOverride === "hackerai-standard"
    ? "hackerai-standard"
    : undefined;
}

/**
 * Evaluate assignment without exposure. Ineligible requests make no flag call.
 * Missing, disabled, invalid or failed evaluation keeps the baseline policy.
 */
export async function resolvePaidAgentContextAssignment({
  posthog,
  userId,
  subscription,
  mode,
  selectedModelOverride,
}: {
  posthog: Pick<PostHog, "getFeatureFlagResult"> | null | undefined;
  userId: string;
  subscription: SubscriptionTier;
  mode: ChatMode;
  selectedModelOverride: SelectedModel | undefined;
}): Promise<PaidAgentContextAssignment | undefined> {
  const requestedSelection = getPaidAgentContextSelection(
    subscription,
    mode,
    selectedModelOverride,
  );
  if (!requestedSelection || !posthog || !userId) return undefined;
  try {
    const variant = await getPostHogFlagWithoutExposure(
      posthog,
      PAID_AGENT_CONTEXT_FLAG,
      userId,
      { subscription, subscription_tier: subscription },
    );
    if (variant !== "control" && variant !== "test") return undefined;
    return { flagKey: PAID_AGENT_CONTEXT_FLAG, variant, requestedSelection };
  } catch {
    // Flag availability must never block an Agent run or change its policy.
    return undefined;
  }
}

/** The single policy decision shared by history, request and compaction. */
export function getAgentContextPolicy({
  subscription,
  mode,
  selectedModelOverride,
  paidAgentContext,
}: {
  subscription: SubscriptionTier;
  mode: ChatMode;
  selectedModelOverride: SelectedModel | undefined;
  paidAgentContext?: Pick<PaidAgentContextAssignment, "variant">;
}): AgentContextPolicy {
  if (isExpandedAgentContextEligible(subscription, mode, selectedModelOverride))
    return "expanded";
  return paidAgentContext?.variant === "test" &&
    getPaidAgentContextSelection(subscription, mode, selectedModelOverride)
    ? "paid_480k"
    : "baseline";
}

/** Whether the treatment budget reaches the 480K trigger on this exact route. */
export function routeSupportsPaidAgentContext(
  subscription: SubscriptionTier,
  modelId: string,
  fallbackModelIds: readonly string[],
): boolean {
  return (
    getAgentContextBudget({
      policy: "paid_480k",
      mode: "agent",
      subscription,
      modelId,
      fallbackModelIds,
    }) >= PAID_AGENT_CONTEXT_MAX_TOKENS
  );
}

export const paidAgentContextExposureUuid = (runId: string) =>
  uuidv5(`hackerai:paid-agent-context:v1:${runId}:exposed`, uuidv5.URL);

/** Closed analytics fields only; never prompts, targets, results or evidence. */
export function paidAgentContextAnalyticsProperties(
  assignment: PaidAgentContextAssignment | undefined,
): Record<string, string | number | boolean> {
  if (!assignment) return {};
  const { exposure } = assignment;
  return {
    [`$feature/${assignment.flagKey}`]: assignment.variant,
    paid_agent_context_variant: assignment.variant,
    paid_agent_context_selection: assignment.requestedSelection,
    paid_agent_context_exposed: exposure !== undefined,
    ...(exposure && {
      paid_agent_context_max_tokens: exposure.contextMaxTokens,
      paid_agent_context_threshold_tokens: exposure.compactionThresholdTokens,
      paid_agent_context_480k_active:
        exposure.compactionThresholdTokens >=
        getSummarizationThresholdTokens(PAID_AGENT_CONTEXT_MAX_TOKENS),
      paid_agent_context_route_supports_480k: exposure.routeSupports480k,
    }),
  };
}
