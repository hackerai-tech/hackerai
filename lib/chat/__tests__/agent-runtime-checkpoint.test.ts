import { createAgentRuntimeCheckpoint } from "../agent-runtime-checkpoint";
import { createActiveRuntimeBudget } from "../active-runtime-budget";

describe("Agent runtime checkpoint", () => {
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
