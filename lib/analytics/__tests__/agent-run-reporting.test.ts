import type { PostHog } from "posthog-node";
import { ChatSDKError } from "@/lib/errors";
import {
  agentFailureCategory,
  agentFailureSignalContext,
  agentRunEventUuid,
  createAgentRunReporting,
} from "../agent-run-reporting";

function setup(
  getFailureSignalContext?: Parameters<
    typeof createAgentRunReporting
  >[0]["getFailureSignalContext"],
) {
  const capture = jest.fn();
  const reporter = createAgentRunReporting({
    posthog: { capture } as unknown as PostHog,
    runId: "run_failed",
    userId: "user_public",
    chatId: "chat_1",
    subscription: "free",
    endpoint: "/api/agent",
    getFailureSignalContext,
  });
  const events = () => capture.mock.calls.map(([event]) => event);
  return { reporter, capture, events };
}

describe("Agent run reporting", () => {
  it.each([false, true])(
    "preserves automatic-continuation=%s on setup failure",
    (isAutoContinue) => {
      const capture = jest.fn();
      const reporter = createAgentRunReporting({
        posthog: { capture } as unknown as PostHog,
        runId: "synthetic",
        userId: "synthetic",
        chatId: "synthetic",
        subscription: "pro",
        endpoint: "/api/agent",
        isAutoContinue,
      });
      reporter.fail(new Error("setup failed"));
      reporter.finalize({ canceled: false });
      expect(
        capture.mock.calls.find(
          ([event]) => event.event === "hackerai-agent_run",
        )?.[0].properties,
      ).toMatchObject({
        is_auto_continue: isAutoContinue,
        run_metadata_version: 1,
        outcome: "error",
      });
    },
  );
  it.each(
    (["agent_model_context_v1", "agent_pro_context_v1"] as const).flatMap(
      (flag) =>
        (["control", "test"] as const).map((variant) => ({ flag, variant })),
    ),
  )(
    "preserves $flag $variant assignment on normal and fallback completion",
    ({ flag, variant }) => {
      const { reporter, events } = setup();
      reporter.setAgentModelContextVariant(variant, flag);
      const capture = jest.fn(() => {
        throw new Error("enqueue failed");
      });
      reporter.captureTerminal(capture, { outcome: "error" });
      expect(capture).toHaveBeenCalledWith({
        outcome: "error",
        agentModelContextVariant: variant,
        agentModelContextFlag: flag,
      });
      reporter.finalize({ canceled: false });
      expect(events()[0].properties[`$feature/${flag}`]).toBe(variant);
      const other =
        flag === "agent_pro_context_v1"
          ? "agent_model_context_v1"
          : "agent_pro_context_v1";
      expect(events()[0].properties[`$feature/${other}`]).toBeUndefined();
    },
  );

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
    ["usage_limit", "budget_exhausted"],
    ["canceled", "request_cancel"],
    ["elapsed_timeout", "elapsed_timeout"],
  ] as const)(
    "reports %s without calling it a technical error",
    (kind, abortSource) => {
      const { reporter, events } = setup();
      reporter.fail(new Error("ignored"), kind);
      reporter.finalize({ canceled: kind === "canceled" });
      expect(events()[0].properties).toMatchObject({
        outcome: "aborted",
        abort_source: abortSource,
        finish_reason: "unknown",
        failure_kind: kind,
      });
    },
  );

  it.each([undefined, "stop", "length", "private arbitrary value"])(
    "retains only bounded observed finish reasons after failed capture: %s",
    (finishReason) => {
      const { reporter, events } = setup();
      reporter.captureTerminal(
        () => {
          throw new Error("enqueue unavailable");
        },
        {
          outcome: "success",
          finishReason,
          stepLimitTelemetry: { stepLimitReached: true },
        },
      );
      reporter.finalize({ canceled: false });
      expect(events()[0].properties).toMatchObject({
        outcome: "success",
        finish_reason:
          finishReason === "stop" || finishReason === "length"
            ? finishReason
            : "unknown",
        step_limit_reached: true,
      });
      expect(JSON.stringify(events())).not.toContain("private arbitrary value");
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

it("keeps reconnect-required Agent attempts unsuccessful in analytics", () => {
  const { reporter, events } = setup();
  reporter.fail(
    new ChatSDKError("offline:sandbox", "Reconnect the selected computer."),
  );
  reporter.finalize({ canceled: false });
  expect(events()[0].properties).toMatchObject({
    outcome: "error",
    failure_category: "sandbox_offline",
  });
  expect(events()[1].properties).toMatchObject({
    cost_dollars: null,
    cost_accounting_status: "incomplete",
  });
});

describe("first-failure signal attribution", () => {
  it("compares standard reason identities without inspecting private reason contents", () => {
    const inspect = jest.fn();
    const reason = new Proxy(
      {},
      {
        get: () => {
          inspect();
          return "PRIVATE";
        },
        getPrototypeOf: () => {
          inspect();
          return null;
        },
        ownKeys: () => {
          inspect();
          return [];
        },
      },
    );
    const platform = new AbortController();
    const stop = new AbortController();
    expect(
      agentFailureSignalContext(reason, platform.signal, stop.signal),
    ).toEqual({
      trigger_aborted: false,
      stop_aborted: false,
      matches_trigger_reason: false,
      matches_stop_reason: false,
    });
    platform.abort(new Error("PRIVATE different reason"));
    stop.abort(reason);
    expect(
      agentFailureSignalContext(reason, platform.signal, stop.signal),
    ).toEqual({
      trigger_aborted: true,
      stop_aborted: true,
      matches_trigger_reason: false,
      matches_stop_reason: true,
    });
    expect(inspect).not.toHaveBeenCalled();
  });

  it("preserves first-failure ordering and the error outcome when cancellation arrives during cleanup", () => {
    const platform = new AbortController();
    const stop = new AbortController();
    const { reporter, events } = setup((error) =>
      agentFailureSignalContext(error, platform.signal, stop.signal),
    );
    reporter.setStage("preparation");
    const error = new Error("PRIVATE failure");
    reporter.fail(error);
    platform.abort(error);
    stop.abort(error);
    reporter.fail(error, "canceled");
    reporter.finalize({ canceled: true });
    reporter.finalize({ canceled: true });
    const terminal = events().filter((x) => x.event === "hackerai-agent_run");
    expect(terminal).toHaveLength(1);
    expect(terminal[0].properties).toMatchObject({
      outcome: "error",
      failure_kind: "error",
      failure_stage: "preparation",
      failure_signal_context_version: 1,
      failure_trigger_aborted: false,
      failure_stop_aborted: false,
      failure_matches_trigger_reason: false,
      failure_matches_stop_reason: false,
      finalization_trigger_aborted: true,
    });
    expect(terminal[0].properties).not.toHaveProperty("abort_source");
    expect(JSON.stringify(events())).not.toContain("PRIVATE");
  });

  it("reads four observer primitives once without spreading or retaining its object", () => {
    const reads = jest.fn();
    const observed = { private_payload: "PRIVATE canary" };
    for (const key of [
      "trigger_aborted",
      "stop_aborted",
      "matches_trigger_reason",
      "matches_stop_reason",
    ]) {
      let first = true;
      Object.defineProperty(observed, key, {
        enumerable: true,
        get: () => {
          reads(key);
          if (first) {
            first = false;
            return true;
          }
          return "PRIVATE changed";
        },
      });
    }
    const { reporter, events } = setup(() => observed as never);
    reporter.fail(new Error("fixture"));
    reporter.finalize({ canceled: true });
    expect(reads).toHaveBeenCalledTimes(4);
    expect(events()[0].properties).toMatchObject({
      failure_signal_context_version: 1,
      failure_trigger_aborted: true,
      failure_stop_aborted: true,
      failure_matches_trigger_reason: true,
      failure_matches_stop_reason: true,
      finalization_trigger_aborted: true,
      outcome: "error",
    });
    expect(JSON.stringify(events())).not.toContain("PRIVATE");
  });

  it.each(["throws", "invalid"])(
    "preserves reporting when the optional observer %s",
    (kind) => {
      const { reporter, events } = setup(() => {
        if (kind === "throws") throw new Error("PRIVATE sink");
        return {
          trigger_aborted: "PRIVATE",
          stop_aborted: false,
          matches_trigger_reason: false,
          matches_stop_reason: false,
        } as never;
      });
      expect(() => reporter.fail(new Error("PRIVATE original"))).not.toThrow();
      reporter.finalize({ canceled: false });
      expect(events()[0].properties.outcome).toBe("error");
      expect(events()[0].properties).not.toHaveProperty(
        "failure_signal_context_version",
      );
      expect(JSON.stringify(events())).not.toContain("PRIVATE");
    },
  );
});
