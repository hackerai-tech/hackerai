import { describe, expect, it, jest } from "@jest/globals";
import {
  BudgetMonitor,
  captureBudgetSnapshot,
  type BudgetSnapshot,
} from "../budget-monitor";
import type { ExtraUsageConfig, RateLimitInfo } from "@/types";

const makeWriter = () =>
  ({
    write: jest.fn(),
  }) as any;

const baseSnapshot: BudgetSnapshot = {
  monthlyLimitPoints: 100,
  monthlyRemainingAtStart: 10,
  monthlyResetTime: new Date("2026-06-30T00:00:00.000Z"),
  extraUsageEnabledAtStart: true,
  extraUsageHasBalanceAtStart: true,
  extraUsageBalanceAtStart: 100,
  extraUsageAutoReload: true,
};

describe("BudgetMonitor", () => {
  it("emits the first budget warning at 75% usage", () => {
    const writer = makeWriter();
    const monitor = new BudgetMonitor(
      {
        ...baseSnapshot,
        monthlyRemainingAtStart: 30,
      },
      writer,
      "pro",
    );

    const decision = monitor.checkAfterStep(0.0005);

    expect(decision.type).toBe("continue");
    expect(writer.write).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "data-rate-limit-warning",
        data: expect.objectContaining({
          warningType: "token-bucket",
          remainingPercent: 25,
          severity: "info",
        }),
      }),
    );
  });

  it("emits the stronger budget warning at 90% usage", () => {
    const writer = makeWriter();
    const monitor = new BudgetMonitor(
      {
        ...baseSnapshot,
        monthlyRemainingAtStart: 15,
      },
      writer,
      "pro",
    );

    const decision = monitor.checkAfterStep(0.0005);

    expect(decision.type).toBe("continue");
    expect(writer.write).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "data-rate-limit-warning",
        data: expect.objectContaining({
          warningType: "token-bucket",
          remainingPercent: 10,
          severity: "warning",
        }),
      }),
    );
  });

  it("aborts with extra_usage_cap when overflow would exceed the monthly extra-usage cap", () => {
    const writer = makeWriter();
    const monitor = new BudgetMonitor(
      {
        ...baseSnapshot,
        extraUsageMonthlyRemainingAtStart: 0,
      },
      writer,
      "pro",
    );

    const decision = monitor.checkAfterStep(0.002);

    expect(decision).toMatchObject({
      type: "abort",
      details: {
        capReason: "extra_usage_cap",
        billingStopReason: "monthly_extra_usage_spending_cap_hit",
        extraUsageAvailable: false,
        extraUsageMonthlyRemainingDollars: 0,
      },
    });
    expect(writer.write).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "data-rate-limit-warning",
        data: expect.objectContaining({
          warningType: "token-bucket",
          cutOff: true,
          capReason: "extra_usage_cap",
        }),
      }),
    );
  });

  it("continues into extra usage when balance and monthly cap remaining cover overflow", () => {
    const writer = makeWriter();
    const snapshot = {
      ...baseSnapshot,
      extraUsageAutoReload: false,
      extraUsageBalanceAtStart: 1,
      extraUsageMonthlyRemainingAtStart: 1,
    };
    const monitor = new BudgetMonitor(snapshot, writer, "pro");

    const decision = monitor.checkAfterStep(0.002);

    expect(decision.type).toBe("continue");
    expect(writer.write).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "data-rate-limit-warning",
        data: expect.objectContaining({
          warningType: "extra-usage-active",
          capReason: "extra_usage_active",
        }),
      }),
    );
  });

  it("classifies empty extra-usage balance separately from spending-cap hits", () => {
    const writer = makeWriter();
    const monitor = new BudgetMonitor(
      {
        ...baseSnapshot,
        extraUsageAutoReload: false,
        extraUsageHasBalanceAtStart: false,
        extraUsageBalanceAtStart: 0,
        extraUsageMonthlyRemainingAtStart: 20,
      },
      writer,
      "ultra",
    );

    const decision = monitor.checkAfterStep(0.002);

    expect(decision).toMatchObject({
      type: "abort",
      details: {
        capReason: "monthly_exhausted",
        billingStopReason: "extra_usage_balance_empty",
        extraUsageAvailable: false,
        extraUsageMonthlyRemainingDollars: 20,
      },
    });
  });

  it("aborts when extra usage is disabled even if balance remains", () => {
    const writer = makeWriter();
    const monitor = new BudgetMonitor(
      {
        ...baseSnapshot,
        extraUsageEnabledAtStart: false,
        extraUsageAutoReload: false,
        extraUsageBalanceAtStart: 10,
        extraUsageMonthlyRemainingAtStart: 20,
      },
      writer,
      "ultra",
    );

    const decision = monitor.checkAfterStep(0.002);

    expect(decision).toMatchObject({
      type: "abort",
      details: {
        capReason: "monthly_exhausted",
        billingStopReason: "extra_usage_disabled",
        extraUsageAvailable: false,
        extraUsageBalanceDollars: 10,
        extraUsageMonthlyRemainingDollars: 20,
      },
    });
    expect(writer.write).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          warningType: "extra-usage-active",
        }),
      }),
    );
  });

  it("aborts with the paid daily free allowance cap reason when overflow is disabled", () => {
    const writer = makeWriter();
    const monitor = new BudgetMonitor(
      {
        monthlyLimitPoints: 1000,
        monthlyRemainingAtStart: 100,
        monthlyResetTime: new Date("2026-06-12T00:00:00.000Z"),
        extraUsageEnabledAtStart: false,
        extraUsageHasBalanceAtStart: false,
        extraUsageBalanceAtStart: 0,
        extraUsageAutoReload: false,
        extraUsageOverflowAllowed: false,
        capReasonOnExhaustion: "paid_daily_free_allowance_cut_off",
        paidDailyFreeAllowance: { mode: "agent" },
      },
      writer,
      "pro",
    );

    const decision = monitor.checkAfterStep(0.02);

    expect(decision).toMatchObject({
      type: "abort",
      details: {
        capReason: "paid_daily_free_allowance_cut_off",
        billingStopReason: "extra_usage_overflow_disabled",
      },
    });
    expect(writer.write).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "data-rate-limit-warning",
        data: expect.objectContaining({
          warningType: "token-bucket",
          cutOff: true,
          capReason: "paid_daily_free_allowance_cut_off",
          limitDollars: 0.1,
        }),
      }),
    );
  });

  it("updates the paid daily allowance banner when a threshold is crossed", () => {
    const writer = makeWriter();
    const monitor = new BudgetMonitor(
      {
        monthlyLimitPoints: 2500,
        monthlyRemainingAtStart: 2500,
        monthlyResetTime: new Date("2026-06-12T00:00:00.000Z"),
        extraUsageEnabledAtStart: false,
        extraUsageHasBalanceAtStart: false,
        extraUsageBalanceAtStart: 0,
        extraUsageAutoReload: false,
        extraUsageOverflowAllowed: false,
        capReasonOnExhaustion: "paid_daily_free_allowance_cut_off",
        paidDailyFreeAllowance: { mode: "agent" },
      },
      writer,
      "pro",
    );

    expect(monitor.checkAfterStep(0.2)).toEqual({ type: "continue" });
    expect(writer.write).toHaveBeenCalledTimes(1);
    expect(writer.write).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "data-rate-limit-warning",
        data: {
          warningType: "paid-daily-free-allowance",
          resetTime: "2026-06-12T00:00:00.000Z",
          subscription: "pro",
          mode: "agent",
          costLimitDollars: 0.25,
          usedDollars: 0.2,
          midStream: true,
        },
      }),
    );
  });

  it("aborts when an explicit agent run spend cap option is crossed", () => {
    const writer = makeWriter();
    const onAgentRunSpendCapHit = jest.fn();
    const monitor = new BudgetMonitor(
      {
        ...baseSnapshot,
        monthlyLimitPoints: 200_000,
        monthlyRemainingAtStart: 100_000,
      },
      writer,
      "pro",
      {
        agentRunSpendCap: { capDollars: 1, basis: "fixed_5_dollars" },
        onAgentRunSpendCapHit,
      },
    );

    const decision = monitor.checkAfterStep(1.25);

    expect(decision.type).toBe("abort-agent-run-spend-cap");
    expect(onAgentRunSpendCapHit).toHaveBeenCalledWith({
      runCostDollars: 1.25,
      runCapDollars: 1,
      monthlyRemainingDollars: 10,
      capBasis: "fixed_5_dollars",
      premiumContinuationAllowed: false,
    });
    expect(writer.write).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "data-rate-limit-warning",
        data: expect.objectContaining({
          warningType: "agent-run-spend-cap",
          subscription: "pro",
          mode: "agent",
          runCostDollars: 1.25,
          runCapDollars: 1,
          capBasis: "fixed_5_dollars",
          premiumContinuationAllowed: false,
        }),
      }),
    );
  });

  it("marks Pro Agent run cap premium continuation as allowed when extra usage is available", () => {
    const writer = makeWriter();
    const monitor = new BudgetMonitor(
      {
        ...baseSnapshot,
        monthlyLimitPoints: 200_000,
        monthlyRemainingAtStart: 100_000,
      },
      writer,
      "pro",
      {
        agentRunSpendCap: { capDollars: 1, basis: "fixed_5_dollars" },
        extraUsageConfig: {
          enabled: true,
          hasBalance: false,
          balanceDollars: 0,
          autoReloadEnabled: true,
        },
      },
    );

    const decision = monitor.checkAfterStep(1.25);

    expect(decision.type).toBe("abort-agent-run-spend-cap");
    expect(writer.write).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "data-rate-limit-warning",
        data: expect.objectContaining({
          warningType: "agent-run-spend-cap",
          premiumContinuationAllowed: true,
        }),
      }),
    );
  });
});

describe("captureBudgetSnapshot", () => {
  it("includes monthly extra-usage remaining for mid-stream guardrails", () => {
    const rateLimitInfo: RateLimitInfo = {
      remaining: 10,
      resetTime: new Date("2026-06-30T00:00:00.000Z"),
      limit: 100,
      monthly: {
        remaining: 10,
        limit: 100,
        resetTime: new Date("2026-06-30T00:00:00.000Z"),
      },
    };
    const extraUsageConfig: ExtraUsageConfig = {
      enabled: true,
      hasBalance: true,
      balanceDollars: 25,
      autoReloadEnabled: true,
      monthlyRemainingDollars: 3,
    };

    expect(
      captureBudgetSnapshot({
        rateLimitInfo,
        extraUsageConfig,
        subscription: "pro",
      }),
    ).toMatchObject({
      extraUsageEnabledAtStart: true,
      extraUsageHasBalanceAtStart: true,
      extraUsageBalanceAtStart: 25,
      extraUsageAutoReload: true,
      extraUsageMonthlyRemainingAtStart: 3,
    });
  });
});

it("cuts off total serving cost at the remaining daily Free Agent budget", () => {
  const writer = makeWriter();
  const monitor = new BudgetMonitor(
    {
      monthlyLimitPoints: 1000,
      monthlyRemainingAtStart: 250,
      monthlyResetTime: new Date("2026-10-02T00:00:00Z"),
      budgetPeriod: "daily",
      capReasonOnExhaustion: "free_daily_cost_exhausted",
      extraUsageEnabledAtStart: false,
      extraUsageHasBalanceAtStart: false,
      extraUsageBalanceAtStart: 0,
      extraUsageAutoReload: false,
    },
    writer,
    "free",
  );
  expect(monitor.checkAfterStep(0.02).type).toBe("continue");
  expect(monitor.checkAfterStep(0.025)).toMatchObject({
    type: "abort",
    details: {
      capReason: "free_daily_cost_exhausted",
      monthlyLimitDollars: 0.1,
    },
  });
  expect(writer.write).toHaveBeenLastCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        bucketType: "daily",
        remainingPercent: 0,
        cutOff: true,
        resetTime: "2026-10-02T00:00:00.000Z",
      }),
    }),
  );
});

describe("BudgetMonitor stop headroom", () => {
  const noExtraUsage = {
    ...baseSnapshot,
    monthlyRemainingAtStart: 20,
    extraUsageEnabledAtStart: false,
  };

  it("reports headroom after each step from the latest step costs", () => {
    const monitor = new BudgetMonitor(noExtraUsage, makeWriter(), "pro");
    // A run starting near its limit has no step cost to project from yet.
    expect(monitor.getStopHeadroom()).toBeUndefined();
    monitor.checkAfterStep(0.0005); // 5 points → 85%
    expect(monitor.getStopHeadroom()).toEqual({
      remainingPoints: 15,
      recentStepCostPoints: 5,
      usedPercent: 85,
    });
    monitor.checkAfterStep(0.0011); // a 6-point step
    for (const cost of [0.0012, 0.0013, 0.0014]) monitor.checkAfterStep(cost);
    // The expensive step has left the recent window.
    expect(monitor.getStopHeadroom()).toEqual({
      remainingPoints: 6,
      recentStepCostPoints: 1,
      usedPercent: 94,
    });
  });

  it.each([
    ["overflow is disallowed", { extraUsageOverflowAllowed: false }, 0],
    ["the monthly cap is spent", { extraUsageMonthlyRemainingAtStart: 0 }, 0],
    [
      "the balance is empty",
      { extraUsageAutoReload: false, extraUsageBalanceAtStart: 0 },
      0,
    ],
    [
      "a balance covers some overflow",
      { extraUsageAutoReload: false, extraUsageBalanceAtStart: 0.002 },
      20,
    ],
    [
      "a monthly cap limits auto-reload",
      { extraUsageMonthlyRemainingAtStart: 0.001 },
      10,
    ],
  ])("counts extra usage when %s", (_, overrides, overflowPoints) => {
    const monitor = new BudgetMonitor(
      { ...baseSnapshot, ...overrides, monthlyRemainingAtStart: 20 },
      makeWriter(),
      "pro",
    );
    monitor.checkAfterStep(0.0011);
    expect(monitor.getStopHeadroom()?.remainingPoints).toBe(9 + overflowPoints);
  });

  it("reports no stop when uncapped auto-reload absorbs overflow", () => {
    const monitor = new BudgetMonitor(
      { ...baseSnapshot, monthlyRemainingAtStart: 20 },
      makeWriter(),
      "pro",
    );
    monitor.checkAfterStep(0.0011);
    expect(monitor.getStopHeadroom()).toBeUndefined();
  });

  it.each([
    ["included usage only", noExtraUsage],
    [
      "a partial extra-usage balance",
      {
        ...noExtraUsage,
        extraUsageEnabledAtStart: true,
        extraUsageAutoReload: false,
        extraUsageBalanceAtStart: 0.0013,
      },
    ],
  ])("runs out of headroom exactly when %s stops the run", (_, snapshot) => {
    const monitor = new BudgetMonitor(snapshot, makeWriter(), "pro");
    for (let step = 1; step <= 10; step++) {
      const decision = monitor.checkAfterStep(step * 0.0006);
      const { remainingPoints } = monitor.getStopHeadroom()!;
      expect(decision.type).toBe(remainingPoints < 0 ? "abort" : "continue");
      if (decision.type === "abort") return;
    }
    throw new Error("run never stopped");
  });
});
