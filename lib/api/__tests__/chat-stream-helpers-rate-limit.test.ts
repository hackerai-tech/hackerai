import { sendRateLimitWarnings } from "@/lib/api/chat-stream-helpers";

jest.mock("@/lib/db/actions", () => ({
  getNotes: jest.fn(),
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

const makeWriter = () =>
  ({
    write: jest.fn(),
  }) as any;

describe("sendRateLimitWarnings", () => {
  const resetTime = new Date("2026-06-30T00:00:00.000Z");
  const emptyMonthlyBucket = {
    remaining: 0,
    limit: 100,
    resetTime,
    monthly: {
      remaining: 0,
      limit: 100,
      resetTime,
    },
  };

  it("announces when Agent uses the paid daily free allowance", () => {
    const writer = makeWriter();

    sendRateLimitWarnings(writer, {
      subscription: "pro",
      mode: "agent",
      rateLimitInfo: {
        remaining: 0,
        limit: 0,
        resetTime,
      },
      paidDailyFreeAllowance: {
        costLimitDollars: 0.25,
        resetTime,
      },
    });

    expect(writer.write).toHaveBeenCalledWith({
      type: "data-rate-limit-warning",
      data: {
        warningType: "paid-daily-free-allowance",
        resetTime: resetTime.toISOString(),
        subscription: "pro",
        mode: "agent",
        costLimitDollars: 0.25,
      },
      transient: true,
    });
  });

  it("shows extra usage active when the included bucket is empty and credits can cover overflow", () => {
    const writer = makeWriter();

    sendRateLimitWarnings(writer, {
      subscription: "pro",
      mode: "ask",
      rateLimitInfo: emptyMonthlyBucket,
      extraUsageConfig: {
        enabled: true,
        hasBalance: true,
        balanceDollars: 10,
        autoReloadEnabled: false,
      },
    });

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

  it("shows extra usage active when auto-reload can cover overflow without prepaid balance", () => {
    const writer = makeWriter();

    sendRateLimitWarnings(writer, {
      subscription: "pro",
      mode: "ask",
      rateLimitInfo: emptyMonthlyBucket,
      extraUsageConfig: {
        enabled: true,
        hasBalance: false,
        balanceDollars: 0,
        autoReloadEnabled: true,
      },
    });

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

  it("keeps the monthly-limit warning when extra usage is unavailable", () => {
    const writer = makeWriter();

    sendRateLimitWarnings(writer, {
      subscription: "pro",
      mode: "ask",
      rateLimitInfo: emptyMonthlyBucket,
    });

    expect(writer.write).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "data-rate-limit-warning",
        data: expect.objectContaining({
          warningType: "token-bucket",
          remainingPercent: 0,
        }),
      }),
    );
  });

  it("does not show extra usage active when the extra-usage monthly cap is exhausted", () => {
    const writer = makeWriter();

    sendRateLimitWarnings(writer, {
      subscription: "pro",
      mode: "ask",
      rateLimitInfo: emptyMonthlyBucket,
      extraUsageConfig: {
        enabled: true,
        hasBalance: true,
        balanceDollars: 10,
        monthlyRemainingDollars: 0,
        autoReloadEnabled: false,
      },
    });

    expect(writer.write).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "data-rate-limit-warning",
        data: expect.objectContaining({
          warningType: "token-bucket",
          remainingPercent: 0,
        }),
      }),
    );
  });
});
