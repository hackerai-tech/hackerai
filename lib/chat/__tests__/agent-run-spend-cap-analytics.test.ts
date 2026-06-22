import { describe, expect, it, jest } from "@jest/globals";
import { PAID_FUNNEL_EVENT_VERSION } from "@/lib/analytics/paid-funnel";
import { phLogger } from "@/lib/posthog/server";
import { captureAgentRunSpendCapHit } from "../agent-run-spend-cap-analytics";

describe("captureAgentRunSpendCapHit", () => {
  it("emits the paid-funnel cap hit event with run and cap context", () => {
    const eventSpy = jest.spyOn(phLogger, "event").mockImplementation(() => {});

    try {
      captureAgentRunSpendCapHit({
        userId: "user_123",
        subscription: "pro",
        mode: "agent",
        chatId: "chat_123",
        endpoint: "/api/chat",
        selectedModel: "hackerai-pro",
        selectedModelOverride: "hackerai-max",
        configuredModelSlug: "anthropic:claude-sonnet-4-6",
        hit: {
          runCostDollars: 5.2,
          runCapDollars: 5,
          monthlyRemainingDollars: 18,
          capBasis: "fixed_5_dollars",
          premiumContinuationAllowed: true,
        },
      });

      expect(eventSpy).toHaveBeenCalledWith(
        "agent_run_spend_cap_hit",
        expect.objectContaining({
          paid_funnel_event_version: PAID_FUNNEL_EVENT_VERSION,
          userId: "user_123",
          subscription_tier: "pro",
          mode: "agent",
          chat_id: "chat_123",
          endpoint: "/api/chat",
          selected_model: "hackerai-pro",
          selected_model_override: "hackerai-max",
          configured_model_slug: "anthropic:claude-sonnet-4-6",
          cap_reason: "agent_run_spend_cap",
          run_cost_dollars: 5.2,
          run_cap_dollars: 5,
          monthly_remaining_dollars: 18,
          cap_basis: "fixed_5_dollars",
          premium_continuation_allowed: true,
          $set: expect.objectContaining({
            subscription_tier: "pro",
            last_agent_run_spend_cap_hit_at: expect.any(String),
          }),
        }),
      );
    } finally {
      eventSpy.mockRestore();
    }
  });
});
