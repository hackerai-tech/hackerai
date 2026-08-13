import {
  createActiveRuntimeBudget,
  createRuntimeSettlementWatchdog,
} from "@/lib/chat/active-runtime-budget";

describe("createActiveRuntimeBudget", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-07-09T12:00:00Z"));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("excludes a long approval pause from elapsed time and the timeout", () => {
    const onExceeded = jest.fn();
    const budget = createActiveRuntimeBudget({
      maxDurationMs: 1_000,
      onExceeded,
    });

    jest.advanceTimersByTime(400);
    budget.pause();
    expect(budget.getElapsedTimeMs()).toBe(400);

    jest.advanceTimersByTime(7 * 24 * 60 * 60 * 1_000);
    expect(budget.getElapsedTimeMs()).toBe(400);
    expect(onExceeded).not.toHaveBeenCalled();

    budget.resume();
    jest.advanceTimersByTime(599);
    expect(onExceeded).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(onExceeded).toHaveBeenCalledTimes(1);
    expect(budget.getElapsedTimeMs()).toBe(1_000);
  });

  it("counts setup time supplied before the budget is created", () => {
    const onExceeded = jest.fn();
    const budget = createActiveRuntimeBudget({
      maxDurationMs: 1_000,
      initialElapsedMs: 750,
      onExceeded,
    });

    jest.advanceTimersByTime(249);
    expect(onExceeded).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(onExceeded).toHaveBeenCalledTimes(1);
    budget.dispose();
  });
});

describe("createRuntimeSettlementWatchdog", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-08-11T12:00:00Z"));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("reports a run that remains unsettled after the diagnostic delay", () => {
    const onStalled = jest.fn();
    const watchdog = createRuntimeSettlementWatchdog({
      delayMs: 30_000,
      onStalled,
    });

    const exceededAt = Date.now();
    watchdog.arm(exceededAt);
    watchdog.arm(exceededAt + 1_000);

    jest.advanceTimersByTime(29_999);
    expect(onStalled).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(onStalled).toHaveBeenCalledTimes(1);
    expect(onStalled).toHaveBeenCalledWith({
      runtimeBudgetExceededAt: exceededAt,
      stalledForMs: 30_000,
    });
  });

  it("does not report after run cleanup begins", () => {
    const onStalled = jest.fn();
    const watchdog = createRuntimeSettlementWatchdog({
      delayMs: 30_000,
      onStalled,
    });

    watchdog.arm();
    jest.advanceTimersByTime(10_000);
    watchdog.dispose();
    jest.advanceTimersByTime(30_000);

    expect(onStalled).not.toHaveBeenCalled();
  });

  it("does not fail the task when diagnostic emission throws", () => {
    const watchdog = createRuntimeSettlementWatchdog({
      delayMs: 30_000,
      onStalled: () => {
        throw new Error("logger unavailable");
      },
    });

    watchdog.arm();

    expect(() => jest.advanceTimersByTime(30_000)).not.toThrow();
  });

  it("does not fail the task when async diagnostic emission rejects", async () => {
    const onStalled = jest
      .fn<Promise<void>, []>()
      .mockRejectedValue(new Error("async logger unavailable"));
    const watchdog = createRuntimeSettlementWatchdog({
      delayMs: 30_000,
      onStalled,
    });

    watchdog.arm();
    jest.advanceTimersByTime(30_000);
    await Promise.resolve();

    expect(onStalled).toHaveBeenCalledTimes(1);
  });
});
