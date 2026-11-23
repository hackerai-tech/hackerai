import {
  createAgentRuntimeCheckpoint,
  resolveAgentRuntimeCheckpointEnabled,
} from "../agent-runtime-checkpoint";
import { createActiveRuntimeBudget } from "../active-runtime-budget";

describe("Agent runtime checkpoint", () => {
  it.each([true, false, null])(
    "uses an available assignment %s",
    async (decision) => {
      await expect(
        resolveAgentRuntimeCheckpointEnabled({
          loadDecision: async () => decision,
          signal: new AbortController().signal,
        }),
      ).resolves.toBe(decision === true);
    },
  );

  it("skips lookup when already stopped, and bypasses a pending lookup on Stop", async () => {
    const controller = new AbortController();
    const loadDecision = jest.fn(() => new Promise<boolean>(() => {}));
    const pending = resolveAgentRuntimeCheckpointEnabled({
      loadDecision,
      signal: controller.signal,
    });
    await Promise.resolve();
    expect(loadDecision).toHaveBeenCalledTimes(1);
    controller.abort();
    await expect(pending).resolves.toBe(false);
    await expect(
      resolveAgentRuntimeCheckpointEnabled({
        loadDecision,
        signal: controller.signal,
      }),
    ).resolves.toBe(false);
    expect(loadDecision).toHaveBeenCalledTimes(1);
  });

  it("bounds optional flag startup time and ignores a late decision", async () => {
    jest.useFakeTimers();
    try {
      let resolveDecision!: (value: boolean) => void;
      const pending = resolveAgentRuntimeCheckpointEnabled({
        loadDecision: () =>
          new Promise<boolean>((resolve) => {
            resolveDecision = resolve;
          }),
        signal: new AbortController().signal,
      });
      await Promise.resolve();
      jest.advanceTimersByTime(1000);
      await expect(pending).resolves.toBe(false);
      resolveDecision(true);
      await expect(pending).resolves.toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it("fails closed on lookup errors", async () => {
    await expect(
      resolveAgentRuntimeCheckpointEnabled({
        loadDecision: async () => {
          throw new Error("unavailable");
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(false);
  });

  it.each([undefined, 0, -1, Infinity, NaN])(
    "ignores unknown or invalid allowance %s",
    (maxDurationMs) => {
      const clock = jest.fn(() => 99_000);
      const checkpoint = createAgentRuntimeCheckpoint({
        enabled: true,
        maxDurationMs,
        getElapsedTimeMs: clock,
        onExposed: jest.fn(),
      });
      expect(checkpoint.takeNotice()).toBeUndefined();
      expect(clock).not.toHaveBeenCalled();
    },
  );

  it("emits once at the threshold, and records exposure only on model start", () => {
    let elapsed = 899;
    const onExposed = jest.fn();
    const checkpoint = createAgentRuntimeCheckpoint({
      enabled: true,
      maxDurationMs: 1000,
      getElapsedTimeMs: () => elapsed,
      onExposed,
    });
    expect(checkpoint.takeNotice()).toBeUndefined();
    checkpoint.recordExposure();
    expect(onExposed).not.toHaveBeenCalled();
    elapsed = 900;
    expect(checkpoint.takeNotice()).toContain("strongest current hypothesis");
    expect(onExposed).not.toHaveBeenCalled();
    checkpoint.recordExposure();
    checkpoint.recordExposure();
    elapsed = 950;
    expect(checkpoint.takeNotice()).toBeUndefined();
    expect(onExposed).toHaveBeenCalledTimes(1);
    expect(onExposed).toHaveBeenCalledWith({
      elapsed_ms: 900,
      allowance_ms: 1000,
    });
  });

  it.each([NaN, Infinity, -1, 1000, 1100])(
    "does not nudge at invalid or exhausted elapsed time %s",
    (elapsed) => {
      const checkpoint = createAgentRuntimeCheckpoint({
        enabled: true,
        maxDurationMs: 1000,
        getElapsedTimeMs: () => elapsed,
        onExposed: jest.fn(),
      });
      expect(checkpoint.takeNotice()).toBeUndefined();
    },
  );

  it("keeps paused time out of the threshold and leaves the existing stop timer alone", () => {
    jest.useFakeTimers();
    try {
      const stop = jest.fn();
      const budget = createActiveRuntimeBudget({
        maxDurationMs: 1000,
        initialElapsedMs: 100,
        onExceeded: stop,
      });
      const checkpoint = createAgentRuntimeCheckpoint({
        enabled: true,
        maxDurationMs: 1000,
        getElapsedTimeMs: budget.getElapsedTimeMs,
        onExposed: jest.fn(),
      });
      jest.advanceTimersByTime(700);
      budget.pause();
      jest.advanceTimersByTime(10_000);
      expect(checkpoint.takeNotice()).toBeUndefined();
      budget.resume();
      jest.advanceTimersByTime(100);
      expect(checkpoint.takeNotice()).toContain(
        "does not ask you to finish early",
      );
      expect(stop).not.toHaveBeenCalled();
      jest.advanceTimersByTime(100);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(checkpoint.takeNotice()).toBeUndefined();
      budget.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  it("fails closed when disabled and isolates new runs", () => {
    const options = {
      enabled: false,
      maxDurationMs: 1000,
      getElapsedTimeMs: () => 950,
      onExposed: jest.fn(),
    };
    expect(createAgentRuntimeCheckpoint(options).takeNotice()).toBeUndefined();
    expect(
      createAgentRuntimeCheckpoint({ ...options, enabled: true }).takeNotice(),
    ).toBeDefined();
    expect(
      createAgentRuntimeCheckpoint({ ...options, enabled: true }).takeNotice(),
    ).toBeDefined();
  });
});

describe("Agent limit wrap-up", () => {
  const atLimit = { completedSteps: 450, maxSteps: 500 };
  const createWrapUp = ({
    wrapUpEnabled = true,
    runtimeEnabled = false,
    elapsed = 0,
  } = {}) => {
    const onRuntimeExposed = jest.fn();
    const onWrapUpExposed = jest.fn();
    const checkpoint = createAgentRuntimeCheckpoint({
      enabled: runtimeEnabled,
      maxDurationMs: 1000,
      getElapsedTimeMs: () => elapsed,
      onExposed: onRuntimeExposed,
      limitWrapUp: { enabled: wrapUpEnabled, onExposed: onWrapUpExposed },
    });
    return { checkpoint, onRuntimeExposed, onWrapUpExposed };
  };

  it("fires once at 90% of the step limit, with exposure only on model start", () => {
    const { checkpoint, onWrapUpExposed } = createWrapUp();
    expect(
      checkpoint.takeNotice({ completedSteps: 449, maxSteps: 500 }),
    ).toBeUndefined();
    const notice = checkpoint.takeNotice(atLimit);
    expect(notice).toContain("<agent_limit_wrapup>");
    expect(notice).toContain("step limit");
    expect(notice).toContain("get_terminal_files");
    expect(onWrapUpExposed).not.toHaveBeenCalled();
    checkpoint.recordExposure();
    checkpoint.recordExposure();
    expect(
      checkpoint.takeNotice({ completedSteps: 460, maxSteps: 500 }),
    ).toBeUndefined();
    expect(onWrapUpExposed).toHaveBeenCalledTimes(1);
    expect(onWrapUpExposed).toHaveBeenCalledWith({
      trigger_kind: "step",
      step_count_bucket: "450+",
      budget_pct_bucket: "none",
    });
  });

  it.each([
    [89.9, undefined],
    [90, "90-94"],
    [99.5, "95-99"],
  ] as const)(
    "uses budget stop pressure %s before the step threshold",
    (budgetUsedPercent, bucket) => {
      const { checkpoint, onWrapUpExposed } = createWrapUp();
      const notice = checkpoint.takeNotice({
        completedSteps: 12,
        maxSteps: 500,
        budgetUsedPercent,
      });
      checkpoint.recordExposure();
      if (!bucket) {
        expect(notice).toBeUndefined();
        expect(onWrapUpExposed).not.toHaveBeenCalled();
        return;
      }
      expect(notice).toContain("usage limit");
      expect(onWrapUpExposed).toHaveBeenCalledWith({
        trigger_kind: "usage",
        step_count_bucket: "10-49",
        budget_pct_bucket: bucket,
      });
    },
  );

  it("re-evaluates a prepared notice that never reached the model", () => {
    const { checkpoint, onWrapUpExposed } = createWrapUp();
    expect(checkpoint.takeNotice(atLimit)).toBeDefined();
    // A failed preparation is retried with fresh progress before dispatch.
    expect(
      checkpoint.takeNotice({ completedSteps: 10, maxSteps: 500 }),
    ).toBeUndefined();
    checkpoint.recordExposure();
    expect(onWrapUpExposed).not.toHaveBeenCalled();
    expect(checkpoint.takeNotice(atLimit)).toBeDefined();
  });

  it("stays silent when the flag is off, even with runtime checkpoint on", () => {
    const { checkpoint, onWrapUpExposed } = createWrapUp({
      wrapUpEnabled: false,
    });
    expect(
      checkpoint.takeNotice({ ...atLimit, budgetUsedPercent: 99 }),
    ).toBeUndefined();
    checkpoint.recordExposure();
    expect(onWrapUpExposed).not.toHaveBeenCalled();
  });

  it("supersedes a simultaneous runtime checkpoint and blocks it afterwards", () => {
    const run = createWrapUp({ runtimeEnabled: true, elapsed: 950 });
    expect(run.checkpoint.takeNotice(atLimit)).toContain(
      "<agent_limit_wrapup>",
    );
    run.checkpoint.recordExposure();
    expect(run.checkpoint.takeNotice(atLimit)).toBeUndefined();
    expect(run.checkpoint.takeNotice()).toBeUndefined();
    expect(run.onWrapUpExposed).toHaveBeenCalledTimes(1);
    expect(run.onRuntimeExposed).not.toHaveBeenCalled();
  });

  it("does not follow an exposed runtime checkpoint", () => {
    const run = createWrapUp({ runtimeEnabled: true, elapsed: 950 });
    expect(
      run.checkpoint.takeNotice({ completedSteps: 10, maxSteps: 500 }),
    ).toContain("<agent_runtime_checkpoint>");
    run.checkpoint.recordExposure();
    expect(run.checkpoint.takeNotice(atLimit)).toBeUndefined();
    run.checkpoint.recordExposure();
    expect(run.onRuntimeExposed).toHaveBeenCalledTimes(1);
    expect(run.onWrapUpExposed).not.toHaveBeenCalled();
  });
});
