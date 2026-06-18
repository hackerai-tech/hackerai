import { describe, expect, it, jest } from "@jest/globals";
import {
  BudgetMonitor,
  captureBudgetSnapshot,
  getProAgentRunSpendCap,
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

    expect(decision).toBe("continue");
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

    expect(decision).toBe("continue");
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

    expect(decision).toBe("abort");
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
    const monitor = new BudgetMonitor(
      {
        ...baseSnapshot,
        extraUsageAutoReload: false,
        extraUsageBalanceAtStart: 1,
        extraUsageMonthlyRemainingAtStart: 1,
      },
      writer,
      "pro",
    );

    const decision = monitor.checkAfterStep(0.002);

    expect(decision).toBe("continue");
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

  it("aborts Pro Agent runs when the per-run spend cap is crossed", () => {
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

    expect(decision).toBe("abort-agent-run-spend-cap");
    expect(onAgentRunSpendCapHit).toHaveBeenCalledWith({
      runCostDollars: 1.25,
      runCapDollars: 1,
      monthlyRemainingDollars: 10,
      capBasis: "fixed_5_dollars",
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
      extraUsageBalanceAtStart: 25,
      extraUsageAutoReload: true,
      extraUsageMonthlyRemainingAtStart: 3,
    });
  });
});

describe("getProAgentRunSpendCap", () => {
  it("returns the lower of five dollars and 25 percent of remaining usage for Pro Agent", () => {
    const snapshot: BudgetSnapshot = {
      ...baseSnapshot,
      monthlyRemainingAtStart: 100_000,
    };

    expect(
      getProAgentRunSpendCap({
        snapshot,
        subscription: "pro",
        mode: "agent",
      }),
    ).toEqual({
      capDollars: 2.5,
      basis: "remaining_25_percent",
    });
  });

  it("uses the fixed five dollar cap when remaining usage is high", () => {
    const snapshot: BudgetSnapshot = {
      ...baseSnapshot,
      monthlyRemainingAtStart: 500_000,
    };

    expect(
      getProAgentRunSpendCap({
        snapshot,
        subscription: "pro",
        mode: "agent",
      }),
    ).toEqual({
      capDollars: 5,
      basis: "fixed_5_dollars",
    });
  });

  it("does not cap non-Pro tiers or Ask mode", () => {
    expect(
      getProAgentRunSpendCap({
        snapshot: baseSnapshot,
        subscription: "pro-plus",
        mode: "agent",
      }),
    ).toBeNull();
    expect(
      getProAgentRunSpendCap({
        snapshot: baseSnapshot,
        subscription: "pro",
        mode: "ask",
      }),
    ).toBeNull();
  });
});
