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
