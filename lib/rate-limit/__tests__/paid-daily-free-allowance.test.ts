import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

describe("paid daily free allowance", () => {
  const mockCreateRedisClient = jest.fn();
  const mockIsFeatureEnabled = jest.fn();
  const redisStore = new Map<string, number>();
  const originalEnv = {
    rollout: process.env.PAID_DAILY_FREE_ALLOWANCE_ROLLOUT_PERCENT,
    requests: process.env.PAID_DAILY_FREE_ALLOWANCE_REQUESTS_PER_DAY,
    cost: process.env.PAID_DAILY_FREE_ALLOWANCE_COST_LIMIT_USD,
    nodeEnv: process.env.NODE_ENV,
  };

  const mockRedis = {
    get: jest.fn(async (key: string) => redisStore.get(key) ?? null),
    eval: jest.fn(async (_script: string, keys: string[], args: number[]) => {
      if (keys.length === 2) {
        const [requestsKey, costKey] = keys;
        const [requestLimit, costLimit] = args;
        const requestsUsed = redisStore.get(requestsKey) ?? 0;
        const costUsed = redisStore.get(costKey) ?? 0;
        if (requestsUsed >= requestLimit) {
          return [0, "request_limit_reached", requestsUsed, costUsed];
        }
        if (costUsed >= costLimit) {
          return [0, "cost_limit_reached", requestsUsed, costUsed];
        }
        const nextRequests = requestsUsed + 1;
        redisStore.set(requestsKey, nextRequests);
        redisStore.set(costKey, costUsed);
        return [1, "ok", nextRequests, costUsed];
      }

      const [costKey] = keys;
      const [costPoints] = args;
      const nextCost = (redisStore.get(costKey) ?? 0) + costPoints;
      redisStore.set(costKey, nextCost);
      return nextCost;
    }),
  };

  const getIsolatedModule = () => {
    let isolatedModule: typeof import("../paid-daily-free-allowance");

    jest.isolateModules(() => {
      jest.doMock("server-only", () => ({}), { virtual: true });
      jest.doMock("../redis", () => ({
        createRedisClient: mockCreateRedisClient,
      }));
      jest.doMock("../../auth/feature-flags", () => ({
        isFeatureEnabled: mockIsFeatureEnabled,
      }));

      isolatedModule = require("../paid-daily-free-allowance");
    });

    return isolatedModule!;
  };

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    redisStore.clear();
    process.env.NODE_ENV = "test";
    process.env.PAID_DAILY_FREE_ALLOWANCE_ROLLOUT_PERCENT = "100";
    delete process.env.PAID_DAILY_FREE_ALLOWANCE_REQUESTS_PER_DAY;
    delete process.env.PAID_DAILY_FREE_ALLOWANCE_COST_LIMIT_USD;
    mockCreateRedisClient.mockReturnValue(mockRedis);
    mockIsFeatureEnabled.mockReturnValue(true);
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-06-11T12:00:00.000Z"));
  });

  afterEach(() => {
    jest.useRealTimers();
    if (originalEnv.rollout === undefined) {
      delete process.env.PAID_DAILY_FREE_ALLOWANCE_ROLLOUT_PERCENT;
    } else {
      process.env.PAID_DAILY_FREE_ALLOWANCE_ROLLOUT_PERCENT =
        originalEnv.rollout;
    }
    if (originalEnv.requests === undefined) {
      delete process.env.PAID_DAILY_FREE_ALLOWANCE_REQUESTS_PER_DAY;
    } else {
      process.env.PAID_DAILY_FREE_ALLOWANCE_REQUESTS_PER_DAY =
        originalEnv.requests;
    }
    if (originalEnv.cost === undefined) {
      delete process.env.PAID_DAILY_FREE_ALLOWANCE_COST_LIMIT_USD;
    } else {
      process.env.PAID_DAILY_FREE_ALLOWANCE_COST_LIMIT_USD = originalEnv.cost;
    }
    process.env.NODE_ENV = originalEnv.nodeEnv;
  });

  const eligibleContext = {
    userId: "user_123",
    subscription: "pro" as const,
    mode: "ask" as const,
    capReason: "monthly_exhausted" as const,
    hasAttachments: false,
  };

  it("reports one available paid Ask rescue by default", async () => {
    const { getPaidDailyFreeAllowanceStatus } = getIsolatedModule();

    const status = await getPaidDailyFreeAllowanceStatus(eligibleContext);

    expect(status).toMatchObject({
      available: true,
      requestLimit: 1,
      requestsUsed: 0,
      requestsRemaining: 1,
      costLimitDollars: 0.1,
      costUsedDollars: 0,
      costRemainingDollars: 0.1,
      resetTimestamp: Date.parse("2026-06-12T00:00:00.000Z"),
    });
  });

  it("excludes unsupported tiers, agent mode, attachments, and rollout-disabled users", async () => {
    const { getPaidDailyFreeAllowanceStatus } = getIsolatedModule();

    await expect(
      getPaidDailyFreeAllowanceStatus({
        ...eligibleContext,
        subscription: "free",
      }),
    ).resolves.toMatchObject({
      available: false,
      unavailableReason: "unsupported_subscription",
    });
    await expect(
      getPaidDailyFreeAllowanceStatus({ ...eligibleContext, mode: "agent" }),
    ).resolves.toMatchObject({
      available: false,
      unavailableReason: "unsupported_mode",
    });
    await expect(
      getPaidDailyFreeAllowanceStatus({
        ...eligibleContext,
        hasAttachments: true,
      }),
    ).resolves.toMatchObject({
      available: false,
      unavailableReason: "attachments_not_supported",
    });

    mockIsFeatureEnabled.mockReturnValue(false);
    await expect(
      getPaidDailyFreeAllowanceStatus(eligibleContext),
    ).resolves.toMatchObject({
      available: false,
      unavailableReason: "rollout_disabled",
    });
  });

  it("reserves only the configured number of requests per UTC day", async () => {
    const { reservePaidDailyFreeAllowanceRequest } = getIsolatedModule();

    await expect(
      reservePaidDailyFreeAllowanceRequest(eligibleContext),
    ).resolves.toMatchObject({
      allowed: true,
      status: {
        requestsUsed: 1,
        requestsRemaining: 0,
      },
    });
    await expect(
      reservePaidDailyFreeAllowanceRequest(eligibleContext),
    ).resolves.toMatchObject({
      allowed: false,
      blockReason: "request_limit_reached",
    });
  });

  it("blocks new rescue requests once recorded cost reaches the daily cap", async () => {
    const {
      getPaidDailyFreeAllowanceStatus,
      recordPaidDailyFreeAllowanceCost,
    } = getIsolatedModule();

    await recordPaidDailyFreeAllowanceCost("user_123", 0.11);

    await expect(
      getPaidDailyFreeAllowanceStatus(eligibleContext),
    ).resolves.toMatchObject({
      available: false,
      unavailableReason: "cost_limit_reached",
      costUsedDollars: 0.11,
      costRemainingDollars: 0,
    });
  });

  it("keys counters to the UTC date and resets at midnight UTC", async () => {
    const {
      getPaidDailyFreeAllowanceKeys,
      getPaidDailyFreeAllowanceStatus,
      reservePaidDailyFreeAllowanceRequest,
    } = getIsolatedModule();

    jest.setSystemTime(new Date("2026-06-11T23:59:00.000Z"));
    await reservePaidDailyFreeAllowanceRequest(eligibleContext);
    const june11Keys = getPaidDailyFreeAllowanceKeys("user_123", "2026-06-11");
    expect(redisStore.get(june11Keys.requestsKey)).toBe(1);

    jest.setSystemTime(new Date("2026-06-12T00:00:01.000Z"));
    const june12Status = await getPaidDailyFreeAllowanceStatus(eligibleContext);
    const june12Keys = getPaidDailyFreeAllowanceKeys("user_123", "2026-06-12");

    expect(june12Status).toMatchObject({
      available: true,
      requestsUsed: 0,
      resetTimestamp: Date.parse("2026-06-13T00:00:00.000Z"),
    });
    expect(redisStore.get(june12Keys.requestsKey)).toBeUndefined();
  });
});
