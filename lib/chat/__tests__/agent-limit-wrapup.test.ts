import { describe, expect, it, jest } from "@jest/globals";
import { createAgentLimitWrapUp } from "../agent-limit-wrapup";
import { BudgetMonitor, type BudgetSnapshot } from "../budget-monitor";

const POINTS_PER_DOLLAR = 10_000;

const noExtraUsage = (
  limitPoints: number,
  remainingPoints = limitPoints,
): BudgetSnapshot => ({
  monthlyLimitPoints: limitPoints,
  monthlyRemainingAtStart: remainingPoints,
  monthlyResetTime: new Date("2026-12-01T00:00:00.000Z"),
  extraUsageEnabledAtStart: false,
  extraUsageHasBalanceAtStart: false,
  extraUsageBalanceAtStart: 0,
  extraUsageAutoReload: false,
});

/** Run equal-cost steps until the wrap-up is first prepared. */
function runUntilWrapUp(snapshot: BudgetSnapshot, stepCostPoints: number) {
  const monitor = new BudgetMonitor(
    snapshot,
    { write: jest.fn() } as any,
    "pro",
  );
  const onExposed = jest.fn();
  const wrapUp = createAgentLimitWrapUp({ onExposed });
  let completedSteps = 0;
  const step = () =>
    monitor.checkAfterStep(
      (++completedSteps * stepCostPoints) / POINTS_PER_DOLLAR,
    );
  for (;;) {
    const notice = wrapUp.prepare({
      completedSteps,
      maxSteps: 500,
      budget: monitor.getStopHeadroom(),
    });
    if (notice) {
      wrapUp.recordExposure();
      return { notice, completedSteps, step, monitor, onExposed };
    }
    expect(step().type).toBe("continue");
  }
}

describe("Agent limit wrap-up", () => {
  it("fires at the step reserve, then keeps one unchanged note", () => {
    const onExposed = jest.fn();
    const wrapUp = createAgentLimitWrapUp({ onExposed });
    expect(
      wrapUp.prepare({ completedSteps: 489, maxSteps: 500 }),
    ).toBeUndefined();
    const notice = wrapUp.prepare({ completedSteps: 490, maxSteps: 500 });
    expect(notice).toContain("close to its step limit");
    expect(notice).toContain("about 10 more model steps");
    expect(notice).toContain("get_terminal_files");
    expect(notice).toContain("done, blocked, and unverified");
    expect(onExposed).not.toHaveBeenCalled();
    wrapUp.recordExposure();
    wrapUp.recordExposure();
    // Later requests repeat the exposed note verbatim and never re-expose it.
    expect(wrapUp.prepare({ completedSteps: 497, maxSteps: 500 })).toBe(notice);
    wrapUp.recordExposure();
    expect(onExposed).toHaveBeenCalledTimes(1);
    expect(onExposed).toHaveBeenCalledWith({
      trigger_kind: "step",
      step_count_bucket: "450+",
      budget_pct_bucket: "none",
    });
  });

  it.each([
    [500, 490],
    [50, 45],
    [3, 2],
  ])("for a %s-step limit, first fires after %s steps", (maxSteps, first) => {
    const wrapUp = createAgentLimitWrapUp({ onExposed: jest.fn() });
    expect(
      wrapUp.prepare({ completedSteps: first - 1, maxSteps }),
    ).toBeUndefined();
    expect(wrapUp.prepare({ completedSteps: first, maxSteps })).toBeDefined();
  });

  it("names usage when the step reserve fires but usage stops first", () => {
    const onExposed = jest.fn();
    const wrapUp = createAgentLimitWrapUp({ onExposed });
    const notice = wrapUp.prepare({
      completedSteps: 490,
      maxSteps: 500,
      // 5 steps of usage left: not yet due, but sooner than 10 steps.
      budget: {
        remainingPoints: 500,
        recentStepCostPoints: 100,
        usedPercent: 95,
      },
    });
    expect(notice).toContain("close to its usage limit");
    expect(notice).toContain("about 5 more model steps");
    wrapUp.recordExposure();
    expect(onExposed).toHaveBeenCalledWith(
      expect.objectContaining({ trigger_kind: "usage" }),
    );
  });

  it("re-evaluates a prepared note that never reached the model", () => {
    const onExposed = jest.fn();
    const wrapUp = createAgentLimitWrapUp({ onExposed });
    expect(
      wrapUp.prepare({ completedSteps: 490, maxSteps: 500 }),
    ).toBeDefined();
    expect(
      wrapUp.prepare({ completedSteps: 10, maxSteps: 500 }),
    ).toBeUndefined();
    wrapUp.recordExposure();
    expect(onExposed).not.toHaveBeenCalled();
    expect(
      wrapUp.prepare({ completedSteps: 490, maxSteps: 500 }),
    ).toBeDefined();
  });

  it("waits for a nearly spent large budget's last steps, not its last 10%", () => {
    // 95% of a $25 included budget is used; $0.01 steps leave about 125 steps.
    const run = runUntilWrapUp(noExtraUsage(250_000, 12_500), 100);
    expect(run.completedSteps).toBe(122);
    expect(run.notice).toContain("close to its usage limit");
    expect(run.onExposed).toHaveBeenCalledWith({
      trigger_kind: "usage",
      step_count_bucket: "100-249",
      budget_pct_bucket: "95-99",
    });
  });

  it.each([
    // A $0.25 free budget where each step costs $0.04.
    ["free monthly", 2_500, 400, 4],
    // One step consumes a third of a small daily allowance.
    ["short daily", 10_000, 3_300, 1],
    ["steady paid", 10_000, 700, 12],
  ])(
    "leaves the %s budget two steps to finish and bounds overshoot to one step",
    (_, limitPoints, stepCostPoints, firstWrapUpStep) => {
      const run = runUntilWrapUp(noExtraUsage(limitPoints), stepCostPoints);
      expect(run.completedSteps).toBe(firstWrapUpStep);
      // Delivering files and the final report both fit before the stop.
      expect(run.step().type).toBe("continue");
      expect(run.step().type).toBe("continue");
      expect(run.monitor.getStopHeadroom()!.remainingPoints).toBeGreaterThan(0);
      // A model that keeps working still meets the unchanged stop on the
      // first step past the budget, overspending by less than one step.
      const stop = run.step();
      expect(stop.type).toBe("abort");
      const overflowPoints = -run.monitor.getStopHeadroom()!.remainingPoints;
      expect(overflowPoints).toBeGreaterThanOrEqual(0);
      expect(overflowPoints).toBeLessThan(stepCostPoints);
    },
  );
});
