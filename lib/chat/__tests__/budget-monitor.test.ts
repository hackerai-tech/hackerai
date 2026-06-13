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
  extraUsageBalanceAtStart: 100,
  extraUsageAutoReload: true,
};

describe("BudgetMonitor", () => {
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

  it("aborts with the paid daily free allowance cap reason when overflow is disabled", () => {
    const writer = makeWriter();
    const monitor = new BudgetMonitor(
      {
        monthlyLimitPoints: 1000,
        monthlyRemainingAtStart: 100,
        monthlyResetTime: new Date("2026-06-12T00:00:00.000Z"),
        extraUsageBalanceAtStart: 0,
        extraUsageAutoReload: false,
        extraUsageOverflowAllowed: false,
        capReasonOnExhaustion: "paid_daily_free_allowance_cut_off",
      },
      writer,
      "pro",
    );

    const decision = monitor.checkAfterStep(0.02);

    expect(decision).toBe("abort");
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
