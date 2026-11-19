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

describe("routine QA spending pool", () => {
  const resetTime = new Date("2026-12-01T00:00:00.000Z");
  const qaRateLimitInfo: RateLimitInfo = {
    remaining: 1_000,
    resetTime,
    limit: 10_000,
    monthly: { remaining: 1_000, limit: 10_000, resetTime },
    pointsDeducted: 50,
    qaSpendPool: "preview",
  };
  // A QA account may also have a funded wallet; QA runs must ignore it.
  const fundedWallet: ExtraUsageConfig = {
    enabled: true,
    hasBalance: true,
    balanceDollars: 100,
    autoReloadEnabled: true,
  };

  it("cuts off at the QA pool without Extra Usage or allowance fallbacks", () => {
    const snapshot = captureBudgetSnapshot({
      rateLimitInfo: { ...qaRateLimitInfo, pointsDeducted: 300 },
      extraUsageConfig: fundedWallet,
      subscription: "pro",
    });
    expect(snapshot).toMatchObject({
      monthlyLimitPoints: 10_000,
      monthlyRemainingAtStart: 1_300,
      extraUsageEnabledAtStart: false,
      extraUsageOverflowAllowed: false,
      capReasonOnExhaustion: "qa_spend_cap",
    });

    const writer = makeWriter();
    const monitor = new BudgetMonitor(snapshot!, writer, "pro", {
      extraUsageConfig: fundedWallet,
    });

    expect(monitor.checkAfterStep(0.09).type).toBe("continue");
    expect(writer.write).not.toHaveBeenCalled();
    expect(monitor.checkAfterStep(0.1)).toMatchObject({
      type: "abort",
      details: {
        capReason: "qa_spend_cap",
        billingStopReason: "qa_spend_cap_exhausted",
        extraUsageAvailable: false,
        extraUsageEnabled: false,
      },
    });
    expect(writer.write).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          warningType: "token-bucket",
          cutOff: true,
          capReason: "qa_spend_cap",
        }),
      }),
    );
    expect(writer.write).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ warningType: "extra-usage-active" }),
      }),
    );
  });

  it("does not offer premium continuation billed to Extra Usage at a QA run cap", () => {
    const snapshot = captureBudgetSnapshot({
      rateLimitInfo: qaRateLimitInfo,
      extraUsageConfig: fundedWallet,
      subscription: "pro",
    })!;
    const onAgentRunSpendCapHit = jest.fn();
    const monitor = new BudgetMonitor(snapshot, makeWriter(), "pro", {
      agentRunSpendCap: { capDollars: 0.01, basis: "fixed_5_dollars" },
      extraUsageConfig: fundedWallet,
      onAgentRunSpendCapHit,
    });

    expect(monitor.checkAfterStep(0.02).type).toBe("abort-agent-run-spend-cap");
    expect(onAgentRunSpendCapHit).toHaveBeenCalledWith(
      expect.objectContaining({ premiumContinuationAllowed: false }),
    );
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
