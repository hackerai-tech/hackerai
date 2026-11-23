jest.mock("@/lib/posthog/server", () => ({
  phLogger: { event: jest.fn() },
}));

import { classifySandboxReadinessFailureSignal } from "../sandbox-readiness-failure";
import {
  CloudAcquisitionBudget,
  CLOUD_ACQUISITION_DEADLINE_MS,
  CLOUD_RESUME_DEADLINE_MS,
  CLOUD_COOLDOWN_MAX_MS,
  MAX_CLOUD_REPROBES,
  CloudAcquisitionTimeoutError,
  CloudAcquisitionBudgetExhaustedError,
  classifyPermanentCloudFailure,
  isCloudAcquisitionBudgetSpent,
} from "../cloud-acquisition-budget";
import { phLogger } from "@/lib/posthog/server";
import { ChatSDKError } from "@/lib/errors";

describe("cloud acquisition deadline", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("retains the last bounded stage when the provider ignores cancellation", async () => {
    let reportStage!: (stage: "connect" | "create") => void;
    const result = new CloudAcquisitionBudget()
      .run(
        async (_, report) => {
          reportStage = report;
          report("discovery");
          await new Promise((resolve) => setTimeout(resolve, 5_000));
          report("connect");
          return new Promise(() => {});
        },
        { userId: "test" },
      )
      .catch((error) => error);
    await jest.advanceTimersByTimeAsync(30_000);
    reportStage("create");
    expect(await result).toMatchObject({ acquisitionStage: "connect" });
    expect(
      JSON.parse(String(jest.mocked(console.warn).mock.calls[0][0])),
    ).toMatchObject({
      acquisition_stage: "connect",
      stage_elapsed_ms: 25_000,
      failed_acquisition_wait_ms: 30_000,
      acquisition_deadline_ms: 30_000,
    });
  });

  it("extends only a confirmed paused resume and never resets the absolute ceiling", async () => {
    const budget = new CloudAcquisitionBudget();
    const result = budget
      .run(
        async (_, report) => {
          await new Promise((resolve) => setTimeout(resolve, 20_000));
          report("connect", { resumingPausedWorkspace: true });
          await new Promise((resolve) => setTimeout(resolve, 50_000));
          report("connect", { resumingPausedWorkspace: true });
          return new Promise(() => {});
        },
        { userId: "test" },
      )
      .catch((error) => error);
    await jest.advanceTimersByTimeAsync(CLOUD_RESUME_DEADLINE_MS);
    expect(await result).toBeInstanceOf(CloudAcquisitionTimeoutError);
    expect(
      JSON.parse(String(jest.mocked(console.warn).mock.calls[0][0])),
    ).toMatchObject({
      acquisition_stage: "connect",
      acquisition_deadline_ms: 90_000,
      failed_acquisition_wait_ms: 90_000,
    });
    await expect(
      budget.run(async () => "unexpected", { userId: "test" }),
    ).rejects.toBeInstanceOf(CloudAcquisitionBudgetExhaustedError);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("cannot extend discovery by claiming a paused workspace", async () => {
    const result = new CloudAcquisitionBudget()
      .run(
        async (_, report) => {
          report("discovery", { resumingPausedWorkspace: true });
          return new Promise(() => {});
        },
        { userId: "test" },
      )
      .catch((error) => error);
    await jest.advanceTimersByTimeAsync(CLOUD_ACQUISITION_DEADLINE_MS);
    expect(await result).toMatchObject({ acquisitionStage: "discovery" });
  });

  it("bounds a never-settling call, aborts its signal, and refuses another attempt", async () => {
    const budget = new CloudAcquisitionBudget();
    let signal!: AbortSignal;
    const acquire = jest.fn((value: AbortSignal) => {
      signal = value;
      return new Promise(() => {});
    });
    const onTimeout = jest.fn();
    const result = budget
      .run(acquire, { userId: "test", onTimeout })
      .catch((error) => error);
    await jest.advanceTimersByTimeAsync(CLOUD_ACQUISITION_DEADLINE_MS);
    expect(await result).toBeInstanceOf(CloudAcquisitionTimeoutError);
    expect(signal.aborted).toBe(true);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    await expect(budget.run(acquire, { userId: "test" })).rejects.toThrow(
      "workspace is preserved",
    );
    const exhausted = await budget
      .run(acquire, { userId: "test" })
      .catch((error) => error);
    expect(classifySandboxReadinessFailureSignal(exhausted)).toBe(
      "operation_timeout",
    );
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("marks the final fast failure as exhausted while preserving its provider cause", async () => {
    const budget = new CloudAcquisitionBudget();
    const cause = new Error("connection timed out");
    const acquire = jest.fn(async () => {
      throw cause;
    });
    const first = await budget
      .run(acquire, { userId: "test" })
      .catch((error) => error);
    expect(first).toBe(cause);
    expect(isCloudAcquisitionBudgetSpent(first)).toBe(false);
    const final = await budget
      .run(acquire, { userId: "test" })
      .catch((error) => error);
    expect(final).toBeInstanceOf(CloudAcquisitionBudgetExhaustedError);
    expect(final.cause).toBe(cause);
    expect(isCloudAcquisitionBudgetSpent(final)).toBe(true);
    expect(classifySandboxReadinessFailureSignal(final)).toBe(
      "operation_timeout",
    );
    await expect(budget.run(acquire, { userId: "test" })).rejects.toMatchObject(
      { cause },
    );
    expect(acquire).toHaveBeenCalledTimes(2);
  });

  it("shares remaining time across failed acquisition attempts", async () => {
    const budget = new CloudAcquisitionBudget();
    const first = budget
      .run(
        () =>
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("504")), 20_000),
          ),
        { userId: "test" },
      )
      .catch((error) => error);
    await jest.advanceTimersByTimeAsync(20_000);
    expect((await first).message).toBe("504");
    const second = budget
      .run(() => new Promise(() => {}), { userId: "test" })
      .catch((error) => error);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(await second).toBeInstanceOf(CloudAcquisitionTimeoutError);
  });

  it("propagates user cancellation promptly without a timeout notice", async () => {
    const controller = new AbortController();
    const onTimeout = jest.fn();
    let requestSignal!: AbortSignal;
    const result = new CloudAcquisitionBudget()
      .run(
        (signal) => {
          requestSignal = signal;
          return new Promise(() => {});
        },
        { userId: "test", signal: controller.signal, onTimeout },
      )
      .catch((error) => error);
    const reason = new DOMException("Stopped", "AbortError");
    controller.abort(reason);
    expect(await result).toBe(reason);
    expect(requestSignal.aborted).toBe(true);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it("never starts acquisition when its caller is already canceled", async () => {
    const controller = new AbortController();
    controller.abort();
    const acquire = jest.fn();
    const onTimeout = jest.fn();
    await expect(
      new CloudAcquisitionBudget().run(acquire, {
        userId: "test",
        signal: controller.signal,
        onTimeout,
      }),
    ).rejects.toBe(controller.signal.reason);
    expect(acquire).not.toHaveBeenCalled();
    expect(onTimeout).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it("does not abort a successfully returned client later", async () => {
    let signal!: AbortSignal;
    await new CloudAcquisitionBudget().run(
      async (value) => {
        signal = value;
        return "connected";
      },
      { userId: "test" },
    );
    await jest.advanceTimersByTimeAsync(60_000);
    expect(signal.aborted).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("does not count caller cancellation as a provider failure", async () => {
    const budget = new CloudAcquisitionBudget();
    const controller = new AbortController();
    const cancelled = budget
      .run(() => new Promise(() => {}), {
        userId: "test",
        signal: controller.signal,
      })
      .catch((error) => error);
    await jest.advanceTimersByTimeAsync(20_000);
    controller.abort();
    await cancelled;
    await expect(
      budget.run(
        async () => {
          throw new Error("504");
        },
        {
          userId: "test",
        },
      ),
    ).rejects.toThrow("504");
    expect(console.warn).not.toHaveBeenCalled();
    const result = budget
      .run(() => new Promise(() => {}), { userId: "test" })
      .catch((error) => error);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(await result).toBeInstanceOf(CloudAcquisitionTimeoutError);
  });
});

/** A provider failure as produced by the E2B acquisition boundary. */
const e2bFailure = (
  errorKind: string,
  diagnostics: Record<string, unknown> = {},
) =>
  Object.assign(new Error("Cloud sandbox is temporarily unavailable."), {
    name: "E2BAcquisitionError",
    errorKind,
    diagnostics: { e2b_phase: "connect", ...diagnostics },
  });

const events = (name: string) =>
  jest
    .mocked(phLogger.event)
    .mock.calls.filter(([event]) => event === name)
    .map(([, fields]) => fields);

describe("cloud acquisition cooldown", () => {
  const context = { userId: "user-1", triggerRunId: "run-1" };
  const DELETION_ADVICE = /delet|Data Controls/i;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  // Two transient failures spend one episode's budget and start a cooldown.
  const spendBudget = async (budget: CloudAcquisitionBudget) => {
    const fail = async () => {
      throw e2bFailure("sandbox", { e2b_http_status: 503 });
    };
    await budget.run(fail, context).catch(() => undefined);
    return budget.run(fail, context).catch((error) => error);
  };

  it("cools down after one typed provider timeout but keeps one other transient failure retryable", async () => {
    const timedOut = new CloudAcquisitionBudget(() => 0.5);
    await timedOut
      .run(async () => {
        throw e2bFailure("timeout", {
          e2b_workspace_identity_operation: "get_info",
        });
      }, context)
      .catch(() => undefined);
    expect(timedOut.isBlocked()).toBe(true);

    const busy = new CloudAcquisitionBudget(() => 0.5);
    await busy
      .run(async () => {
        throw e2bFailure("sandbox", { e2b_http_status: 503 });
      }, context)
      .catch(() => undefined);
    expect(busy.isBlocked()).toBe(false);
  });

  it("cools down after a transient failure and restores cloud tools when a re-probe succeeds", async () => {
    const budget = new CloudAcquisitionBudget(() => 0.5);
    const spent = await spendBudget(budget);
    expect(spent).toBeInstanceOf(CloudAcquisitionBudgetExhaustedError);
    expect(spent.message).toContain("temporarily unavailable");
    expect(spent.message).toContain("after about 60 seconds");
    expect(spent.message).not.toMatch(DELETION_ADVICE);
    expect(budget.isBlocked()).toBe(true);

    const acquire = jest.fn(async () => "connected");
    await jest.advanceTimersByTimeAsync(30_000);
    await expect(budget.run(acquire, context)).rejects.toThrow(
      "after about 30 seconds",
    );
    expect(acquire).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(30_000);
    expect(budget.isBlocked()).toBe(false);
    await expect(budget.run(acquire, context)).resolves.toBe("connected");
    await expect(budget.run(acquire, context)).resolves.toBe("connected");
    expect(budget.blocksCachedSandbox()).toBe(false);
    expect(events("cloud_sandbox_cooldown_entered")).toEqual([
      expect.objectContaining({
        userId: "user-1",
        trigger_run_id: "run-1",
        failure_source: "acquisition",
        cooldown_ms: 60_000,
        error_name: "E2BAcquisitionError",
      }),
    ]);
    expect(events("cloud_sandbox_reprobe_completed")).toEqual([
      expect.objectContaining({ outcome: "success", reprobe_index: 1 }),
    ]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("puts a timed-out acquisition into cooldown and re-probes with a full per-call deadline", async () => {
    const budget = new CloudAcquisitionBudget(() => 0.5);
    const hang = () => new Promise<never>(() => {});
    const first = budget.run(hang, context).catch((error) => error);
    await jest.advanceTimersByTimeAsync(CLOUD_ACQUISITION_DEADLINE_MS);
    const timeout = await first;
    expect(timeout).toBeInstanceOf(CloudAcquisitionTimeoutError);
    expect(timeout.message).toContain("after about 60 seconds");

    await jest.advanceTimersByTimeAsync(60_000);
    const reprobe = budget.run(hang, context).catch((error) => error);
    await jest.advanceTimersByTimeAsync(CLOUD_ACQUISITION_DEADLINE_MS - 1);
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(1);
    // The failed re-probe doubles the next cooldown.
    expect((await reprobe).message).toContain("after about 2 minutes");
    expect(jest.getTimerCount()).toBe(0);
  });

  it("grows the cooldown with jitter up to the cap and stops re-probing after the limit", async () => {
    const budget = new CloudAcquisitionBudget(() => 1);
    await spendBudget(budget);
    const acquire = jest.fn(async () => {
      throw e2bFailure("timeout");
    });
    for (let probe = 1; probe <= MAX_CLOUD_REPROBES; probe++) {
      await jest.advanceTimersByTimeAsync(CLOUD_COOLDOWN_MAX_MS);
      await budget.run(acquire, context).catch(() => undefined);
    }
    expect(acquire).toHaveBeenCalledTimes(MAX_CLOUD_REPROBES);
    expect(
      events("cloud_sandbox_cooldown_entered").map((f) => f?.cooldown_ms),
    ).toEqual([72_000, 144_000, 288_000, 300_000, 300_000]);

    await jest.advanceTimersByTimeAsync(60 * 60_000);
    const refused = await budget.run(acquire, context).catch((error) => error);
    expect(refused).toBeInstanceOf(CloudAcquisitionBudgetExhaustedError);
    expect(refused.disabledReason).toBe("reprobe_limit");
    expect(refused.message).not.toMatch(DELETION_ADVICE);
    expect(acquire).toHaveBeenCalledTimes(MAX_CLOUD_REPROBES);
    expect(events("cloud_sandbox_disabled_for_run")).toEqual([
      expect.objectContaining({ disabled_reason: "reprobe_limit" }),
    ]);
  });

  it("keeps a permanent failure disabled for the run without re-probing", async () => {
    const budget = new CloudAcquisitionBudget();
    const missing = e2bFailure("other_error", {
      e2b_workspace_identity_operation: "validate",
    });
    const acquire = jest.fn(async () => {
      throw missing;
    });
    // The failing call keeps its original error for existing handling.
    await expect(budget.run(acquire, context)).rejects.toBe(missing);
    await jest.advanceTimersByTimeAsync(60 * 60_000);
    const refused = await budget.run(acquire, context).catch((error) => error);
    expect(refused.disabledReason).toBe("workspace_recovery_required");
    expect(refused.message).toContain("workspace recovery prompt");
    expect(refused.message).not.toMatch(DELETION_ADVICE);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(events("cloud_sandbox_cooldown_entered")).toEqual([]);
  });

  it.each([
    ["E2B authentication", e2bFailure("authentication"), "authorization"],
    [
      "E2B forbidden status",
      e2bFailure("sandbox", { e2b_http_status: 403 }),
      "authorization",
    ],
    ["template", e2bFailure("template"), "configuration"],
    [
      "missing pinned workspace",
      e2bFailure("not_found", { e2b_workspace_identity_operation: "get_info" }),
      "workspace_recovery_required",
    ],
    [
      "account suspension",
      new ChatSDKError("forbidden:chat", "suspended"),
      "account_restricted",
    ],
    [
      "provider busy",
      e2bFailure("sandbox", { e2b_http_status: 503 }),
      undefined,
    ],
    [
      "rate limit",
      e2bFailure("rate_limit", { e2b_http_status: 429 }),
      undefined,
    ],
    [
      "transient pinned identity lookup",
      e2bFailure("timeout", { e2b_workspace_identity_operation: "get_info" }),
      undefined,
    ],
    [
      "acquisition timeout",
      new CloudAcquisitionTimeoutError("connect"),
      undefined,
    ],
    [
      // Store errors and pinned region/phase mismatches share this guard
      // error; guards re-run on every re-probe, so it is retryable.
      "workspace guard error (store or pinned mismatch)",
      Object.assign(new Error("needs recovery"), {
        name: "CloudWorkspaceUnavailableError",
      }),
      undefined,
    ],
    [
      "invalid managed-egress configuration",
      e2bFailure("egress_configuration"),
      "configuration",
    ],
    ["network", new TypeError("fetch failed"), undefined],
  ])("classifies %s", (_label, error, expected) => {
    expect(classifyPermanentCloudFailure(error)).toBe(expected);
  });

  it("enters the same cooldown for readiness failures and ends it on a passing check", async () => {
    const budget = new CloudAcquisitionBudget(() => 0.5);
    budget.recordReadinessFailure(context);
    budget.recordReadinessFailure(context);
    expect(budget.blockedMessage()).toContain("after about 60 seconds");
    expect(budget.blockedMessage()).not.toMatch(DELETION_ADVICE);
    expect(events("cloud_sandbox_cooldown_entered")).toEqual([
      expect.objectContaining({ failure_source: "readiness" }),
    ]);
    budget.recordReadinessSuccess();
    expect(budget.isBlocked()).toBe(false);
    expect(budget.blocksCachedSandbox()).toBe(false);
  });

  it("leaves no timer after a canceled re-probe and lets the next call probe again", async () => {
    const budget = new CloudAcquisitionBudget(() => 0.5);
    await spendBudget(budget);
    await jest.advanceTimersByTimeAsync(60_000);
    const controller = new AbortController();
    const canceled = budget
      .run(() => new Promise<never>(() => {}), {
        ...context,
        signal: controller.signal,
      })
      .catch((error) => error);
    controller.abort();
    await canceled;
    expect(jest.getTimerCount()).toBe(0);
    expect(events("cloud_sandbox_reprobe_completed")).toEqual([
      expect.objectContaining({ outcome: "canceled" }),
    ]);
    await expect(budget.run(async () => "ok", context)).resolves.toBe("ok");
    expect(events("cloud_sandbox_cooldown_entered")).toHaveLength(1);
  });
});
