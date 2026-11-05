import { describe, expect, it, jest } from "@jest/globals";
import { createAgentStopSignal } from "../agent-stop-signal";

describe("Agent stop diagnostics", () => {
  it.each([
    "trigger_platform",
    "active_runtime_budget",
    "auto_review_circuit_breaker",
    "post_wait_authorization_denied",
    "usage_settlement_uncovered",
  ] as const)(
    "reports %s without exposing or replacing its reason",
    (source) => {
      const onAbort = jest.fn();
      const stop = createAgentStopSignal({
        onAbort,
        getStreamState: () => ({ stoppedDueToBudgetExhaustion: true }),
      });
      const privateReason = {
        message: "synthetic private cancellation detail",
      };
      stop.abort(source, privateReason);
      expect(stop.controller.signal.aborted).toBe(true);
      expect(stop.controller.signal.reason).toBe(privateReason);
      expect(onAbort.mock.calls).toEqual([[source]]);
    },
  );

  it.each(["agent_run_spend_cap", "budget_monitor", undefined] as const)(
    "observes shared-runner aborts with source %s",
    (source) => {
      const onAbort = jest.fn();
      const stop = createAgentStopSignal({
        onAbort,
        getStreamState: () =>
          source === "agent_run_spend_cap"
            ? { stoppedDueToAgentRunSpendCap: true }
            : source === "budget_monitor"
              ? { stoppedDueToBudgetExhaustion: true }
              : undefined,
      });
      stop.controller.abort();
      expect(onAbort.mock.calls).toEqual([[source ?? "unattributed"]]);
      expect(stop.controller.signal.reason).toMatchObject({
        name: "AbortError",
      });
    },
  );

  it("retains the first stop across later guards and platform cancellation", () => {
    const onAbort = jest.fn();
    const stop = createAgentStopSignal({
      onAbort,
      getStreamState: () => ({ stoppedDueToBudgetExhaustion: true }),
    });
    stop.controller.abort();
    const firstReason = stop.controller.signal.reason;
    stop.abort("usage_settlement_uncovered");
    stop.abort("trigger_platform", new Error("later platform stop"));
    expect(stop.controller.signal.reason).toBe(firstReason);
    expect(onAbort.mock.calls).toEqual([["budget_monitor"]]);
  });

  it("keeps cancellation and downstream abort listeners working if diagnostics fail", () => {
    const downstream = jest.fn();
    const stop = createAgentStopSignal({
      getStreamState: () => {
        throw new Error("attribution failed");
      },
      onAbort: () => {
        throw new Error("logger failed");
      },
    });
    stop.controller.signal.addEventListener("abort", downstream);
    expect(() => stop.controller.abort()).not.toThrow();
    expect(stop.controller.signal.aborted).toBe(true);
    expect(downstream).toHaveBeenCalledTimes(1);
  });

  it("removes observation on normal completion without canceling anything", () => {
    const onAbort = jest.fn();
    const downstream = jest.fn();
    const stop = createAgentStopSignal({
      onAbort,
      getStreamState: () => undefined,
    });
    stop.controller.signal.addEventListener("abort", downstream);
    stop.dispose();
    expect(stop.controller.signal.aborted).toBe(false);
    expect(onAbort).not.toHaveBeenCalled();
    stop.abort("trigger_platform");
    expect(downstream).toHaveBeenCalledTimes(1);
    expect(onAbort).not.toHaveBeenCalled();
  });
});
