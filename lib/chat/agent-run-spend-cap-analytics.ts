import {
  PAID_FUNNEL_EVENTS,
  paidFunnelProperties,
} from "@/lib/analytics/paid-funnel";
import { AGENT_RUN_SPEND_CAP_REASON } from "@/lib/chat/agent-run-spend-cap";
import type { AgentRunSpendCapHit } from "@/lib/chat/agent-run-spend-cap";
import { phLogger } from "@/lib/posthog/server";
import type { ChatMode, SubscriptionTier } from "@/types";

export interface CaptureAgentRunSpendCapHitArgs {
  userId: string;
  subscription: SubscriptionTier;
  mode: ChatMode;
  chatId: string;
  endpoint: string;
  selectedModel: string;
  selectedModelOverride?: string;
  configuredModelSlug: string;
  hit: AgentRunSpendCapHit;
}

export function captureAgentRunSpendCapHit({
  userId,
  subscription,
  mode,
  chatId,
  endpoint,
  selectedModel,
  selectedModelOverride,
  configuredModelSlug,
  hit,
}: CaptureAgentRunSpendCapHitArgs) {
  phLogger.event(
    PAID_FUNNEL_EVENTS.agentRunSpendCapHit,
    paidFunnelProperties({
      userId,
      subscription_tier: subscription,
      mode,
      chat_id: chatId,
      endpoint,
      selected_model: selectedModel,
      selected_model_override: selectedModelOverride,
      configured_model_slug: configuredModelSlug,
      cap_reason: AGENT_RUN_SPEND_CAP_REASON,
      run_cost_dollars: hit.runCostDollars,
      run_cap_dollars: hit.runCapDollars,
      monthly_remaining_dollars: hit.monthlyRemainingDollars,
      cap_basis: hit.capBasis,
      premium_continuation_allowed: hit.premiumContinuationAllowed,
      $set: {
        subscription_tier: subscription,
        last_agent_run_spend_cap_hit_at: new Date().toISOString(),
      },
    }),
  );
}
