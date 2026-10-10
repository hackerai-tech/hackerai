import type { PostHog } from "posthog-node";
import { ChatSDKError } from "@/lib/errors";
import {
  agentFailureCategory,
  agentRunEventUuid,
  createAgentRunReporting,
} from "../agent-run-reporting";

function setup() {
  const capture = jest.fn();
  const reporter = createAgentRunReporting({
    posthog: { capture } as unknown as PostHog,
    runId: "run_failed",
    userId: "user_public",
    chatId: "chat_1",
    subscription: "free",
    endpoint: "/api/agent",
  });
  const events = () => capture.mock.calls.map(([event]) => event);
  return { reporter, capture, events };
}

describe("Agent run reporting", () => {
  it("reports database setup failure once without pretending missing costs are zero", () => {
    const { reporter, events } = setup();
    reporter.fail(
      new ChatSDKError(
        "offline:database",
        "TooManyConcurrentRequests: 256 concurrent queries",
      ),
    );
    reporter.finalize({
      canceled: false,
      triggerCostDollars: 0.0025,
      triggerDurationMs: 5000,
    });
    reporter.finalize({ canceled: false });
    expect(events()).toHaveLength(2);
    expect(events()[0]).toMatchObject({
      event: "hackerai-agent_run",
      properties: {
        trigger_run_id: "run_failed",
        outcome: "error",
        failure_stage: "setup",
        failure_category: "database_concurrency",
      },
    });
    expect(events()[1]).toMatchObject({
      event: "hackerai-usage_cost",
      properties: {
        cost_dollars: null,
        model_cost_dollars: null,
        cost_accounting_status: "incomplete",
        usage_settlement_status: "unknown",
        known_trigger_cost_dollars: 0.0025,
        observed_accumulated_cost_dollars: null,
        trigger_cost_is_final: false,
      },
    });
    expect(events()[1].properties).not.toHaveProperty(
      "included_points_deducted",
    );
  });

  it("preserves the preparation cause before a provider wrapper or cleanup error", () => {
    const { reporter, events } = setup();
    reporter.setStage("preparation");
    reporter.fail(
      new TypeError(
        "private prompt and https://target.invalid/private?token=secret",
      ),
    );
    reporter.fail(new Error("Provider terminal error category=unknown"));
    reporter.finalize({ canceled: false, observedAccumulatedCostDollars: 0 });
    expect(events()[0].properties).toMatchObject({
      failure_stage: "preparation",
      failure_category: "type_error",
    });
    expect(events()[1].properties.observed_accumulated_cost_dollars).toBe(0);
    expect(JSON.stringify(events())).not.toMatch(
      /private|secret|target.invalid|prompt/,
    );
  });

  it.each([
    ["usage_limit", "budget_exhausted", "usage_limit"],
    ["canceled", "request_cancel", "canceled"],
    ["elapsed_timeout", "elapsed_timeout", "elapsed_timeout"],
  ] as const)(
    "reports %s without calling it a technical error",
    (kind, abortSource, finishReason) => {
      const { reporter, events } = setup();
      reporter.fail(new Error("ignored"), kind);
      reporter.finalize({ canceled: kind === "canceled" });
      expect(events()[0].properties).toMatchObject({
        outcome: "aborted",
        abort_source: abortSource,
        finish_reason: finishReason,
      });
    },
  );

  it("uses cancellation when no exception reached the outer catch", () => {
    const { reporter, events } = setup();
    reporter.finalize({ canceled: true });
    expect(events()[0].properties).toMatchObject({
      outcome: "aborted",
      abort_source: "request_cancel",
    });
  });

  it("does not emit fallback records after successful normal or retry completion", () => {
    const { reporter, capture, events } = setup();
    const terminal = { event: "hackerai-agent_run" };
    const cost = { event: "hackerai-usage_cost" };
    reporter.captureCost(capture, cost);
    reporter.captureTerminal(capture, terminal);
    reporter.captureCost(capture, cost);
    reporter.captureTerminal(capture, terminal);
    reporter.fail(new Error("late persistence failure"));
    reporter.finalize({ canceled: false });
    expect(events()).toEqual([cost, terminal]);
  });

  it.each(["terminal", "cost"] as const)(
    "fills only the missing report after %s captured",
    (completed) => {
      const { reporter, capture, events } = setup();
      if (completed === "terminal")
        reporter.captureTerminal(capture, { event: "hackerai-agent_run" });
      else reporter.captureCost(capture, { event: "hackerai-usage_cost" });
      reporter.finalize({ canceled: false });
      expect(events()).toHaveLength(2);
      expect(new Set(events().map((e) => e.event)).size).toBe(2);
    },
  );

  it("records unknown settlement after a cost enqueue failure", () => {
    const { reporter, capture, events } = setup();
    const unavailable = () => {
      throw new Error("offline");
    };
    expect(() => reporter.captureCost(unavailable, undefined)).not.toThrow();
    reporter.captureTerminal(capture, { event: "hackerai-agent_run" });
    reporter.finalize({ canceled: false });
    expect(events()[1].properties.usage_settlement_status).toBe("unknown");
  });

  it("preserves a known successful outcome if its analytics enqueue fails", () => {
    const { reporter, events } = setup();
    reporter.captureTerminal(
      () => {
        throw new Error("offline");
      },
      { outcome: "success" },
    );
    reporter.fail(new Error("later cleanup error"));
    reporter.finalize({ canceled: false });
    expect(events()[0].properties.outcome).toBe("success");
  });

  it("allows a failed enqueue to retry and does not let it suppress the other event", () => {
    const { reporter, capture, events } = setup();
    capture.mockImplementationOnce(() => {
      throw new Error("offline");
    });
    expect(() => reporter.finalize({ canceled: false })).not.toThrow();
    reporter.finalize({ canceled: false });
    expect(events().map((e) => e.event)).toEqual([
      "hackerai-agent_run",
      "hackerai-usage_cost",
      "hackerai-agent_run",
    ]);
    expect(events()[0].uuid).toBe(events()[2].uuid);
  });

  it("has stable per-run event identities and distinct terminal/cost identities", () => {
    const { reporter, events } = setup();
    reporter.finalize({ canceled: false });
    expect(events()[0].uuid).toBe(
      agentRunEventUuid("run_failed", "hackerai-agent_run"),
    );
    expect(events()[1].uuid).toBe(
      agentRunEventUuid("run_failed", "hackerai-usage_cost"),
    );
    expect(events()[0].uuid).not.toBe(events()[1].uuid);
    expect(events()[0].uuid).not.toBe(
      agentRunEventUuid("run_other", "hackerai-agent_run"),
    );
  });

  it("keeps unavailable and invalid cost observations unknown", () => {
    const { reporter, events } = setup();
    reporter.finalize({
      canceled: false,
      triggerCostDollars: NaN,
      observedAccumulatedCostDollars: -1,
    });
    expect(events()[1].properties).toMatchObject({
      known_trigger_cost_dollars: null,
      observed_accumulated_cost_dollars: null,
    });
  });

  it("tolerates missing PostHog configuration", () => {
    const reporter = createAgentRunReporting({
      posthog: null,
      runId: "run",
      userId: "user",
      chatId: "chat",
      subscription: "free",
      endpoint: "/api/agent",
    });
    expect(() => reporter.finalize({ canceled: false })).not.toThrow();
  });
});

describe("safe failure classification", () => {
  it("finds a wrapped concurrency cause without sending its message", () => {
    const cause = new Error("Too many concurrent requests; private data");
    expect(agentFailureCategory(new Error("wrapper", { cause }))).toBe(
      "database_concurrency",
    );
  });
  it("bounds cycles and handles hostile error getters", () => {
    const error = { cause: {} };
    error.cause = error;
    expect(agentFailureCategory(error)).toBe("unknown");
    expect(
      agentFailureCategory({
        get cause() {
          throw new Error("getter");
        },
      }),
    ).toBe("unknown");
  });
});
