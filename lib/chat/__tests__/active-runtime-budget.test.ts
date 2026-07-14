import { createActiveRuntimeBudget } from "@/lib/chat/active-runtime-budget";

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
