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
    agentRollout: process.env.PAID_DAILY_FREE_ALLOWANCE_AGENT_ROLLOUT_PERCENT,
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
        // Mirrors the Lua script: requestLimit <= 0 means no request cap and
        // the request counter is left untouched.
        const hasRequestCap = requestLimit > 0;
        if (hasRequestCap && requestsUsed >= requestLimit) {
          return [0, "request_limit_reached", requestsUsed, costUsed];
        }
        if (costUsed >= costLimit) {
          return [0, "cost_limit_reached", requestsUsed, costUsed];
        }
        const nextRequests = hasRequestCap ? requestsUsed + 1 : requestsUsed;
        if (hasRequestCap) redisStore.set(requestsKey, nextRequests);
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
    delete process.env.PAID_DAILY_FREE_ALLOWANCE_AGENT_ROLLOUT_PERCENT;
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
    if (originalEnv.agentRollout === undefined) {
      delete process.env.PAID_DAILY_FREE_ALLOWANCE_AGENT_ROLLOUT_PERCENT;
    } else {
      process.env.PAID_DAILY_FREE_ALLOWANCE_AGENT_ROLLOUT_PERCENT =
        originalEnv.agentRollout;
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

  it("reports one available paid rescue by default", async () => {
    const { getPaidDailyFreeAllowanceStatus } = getIsolatedModule();

    const status = await getPaidDailyFreeAllowanceStatus(eligibleContext);

    expect(status).toMatchObject({
      available: true,
      requestLimit: 1,
      requestsUsed: 0,
      requestsRemaining: 1,
      costLimitDollars: 0.25,
      costUsedDollars: 0,
      costRemainingDollars: 0.25,
      resetTimestamp: Date.parse("2026-06-12T00:00:00.000Z"),
    });
  });

  it("supports Agent mode while keeping Ask attachments excluded", async () => {
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
    ).resolves.toMatchObject({ available: true });
    await expect(
      getPaidDailyFreeAllowanceStatus({
        ...eligibleContext,
        mode: "agent",
        hasAttachments: true,
      }),
    ).resolves.toMatchObject({ available: true });
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

  it("excludes unsupported tiers and rollout-disabled users", async () => {
    const { getPaidDailyFreeAllowanceStatus } = getIsolatedModule();
    await expect(
      getPaidDailyFreeAllowanceStatus({
        ...eligibleContext,
        subscription: "team",
        mode: "agent",
      }),
    ).resolves.toMatchObject({
      available: false,
      unavailableReason: "unsupported_subscription",
    });
    mockIsFeatureEnabled.mockReturnValue(false);
    await expect(
      getPaidDailyFreeAllowanceStatus(eligibleContext),
    ).resolves.toMatchObject({
      available: false,
      unavailableReason: "rollout_disabled",
    });
  });

  describe("Agent mode on the Auto model", () => {
    const agentContext = { ...eligibleContext, mode: "agent" as const };

    it("is fully rolled out independently of the Ask rollout", async () => {
      process.env.PAID_DAILY_FREE_ALLOWANCE_ROLLOUT_PERCENT = "10";
      const { getPaidDailyFreeAllowanceStatus } = getIsolatedModule();

      await getPaidDailyFreeAllowanceStatus(agentContext);
      await getPaidDailyFreeAllowanceStatus(eligibleContext);

      expect(mockIsFeatureEnabled).toHaveBeenNthCalledWith(
        1,
        "user_123",
        "paid-daily-free-allowance",
        100,
      );
      expect(mockIsFeatureEnabled).toHaveBeenNthCalledWith(
        2,
        "user_123",
        "paid-daily-free-allowance",
        10,
      );
    });

    it("honours an explicit Agent rollout override", async () => {
      process.env.PAID_DAILY_FREE_ALLOWANCE_AGENT_ROLLOUT_PERCENT = "25";
      const { getPaidDailyFreeAllowanceStatus } = getIsolatedModule();

      await expect(
        getPaidDailyFreeAllowanceStatus(agentContext),
      ).resolves.toMatchObject({ rolloutPercent: 25 });
      expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
        "user_123",
        "paid-daily-free-allowance",
        25,
      );
    });

    it("has no request cap and is limited only by the cost cap", async () => {
      const {
        getPaidDailyFreeAllowanceStatus,
        reservePaidDailyFreeAllowanceRequest,
        recordPaidDailyFreeAllowanceCost,
      } = getIsolatedModule();

      await expect(
        getPaidDailyFreeAllowanceStatus(agentContext),
      ).resolves.toMatchObject({
        available: true,
        requestLimit: null,
        requestsRemaining: null,
        costLimitDollars: 0.25,
      });

      for (let i = 0; i < 3; i += 1) {
        await expect(
          reservePaidDailyFreeAllowanceRequest(agentContext),
        ).resolves.toMatchObject({
          allowed: true,
          status: { available: true, requestsRemaining: null },
        });
      }

      await recordPaidDailyFreeAllowanceCost("user_123", 0.25);
      await expect(
        reservePaidDailyFreeAllowanceRequest(agentContext),
      ).resolves.toMatchObject({
        allowed: false,
        blockReason: "cost_limit_reached",
      });
    });

    it("does not consume the Ask request budget", async () => {
      const { reservePaidDailyFreeAllowanceRequest } = getIsolatedModule();

      await reservePaidDailyFreeAllowanceRequest(agentContext);
      await reservePaidDailyFreeAllowanceRequest(agentContext);

      await expect(
        reservePaidDailyFreeAllowanceRequest(eligibleContext),
      ).resolves.toMatchObject({
        allowed: true,
        status: { requestsUsed: 1, requestsRemaining: 0 },
      });
    });

    it("shares the daily cost pool with Ask", async () => {
      const {
        getPaidDailyFreeAllowanceStatus,
        recordPaidDailyFreeAllowanceCost,
      } = getIsolatedModule();

      await recordPaidDailyFreeAllowanceCost("user_123", 0.25);

      await expect(
        getPaidDailyFreeAllowanceStatus(agentContext),
      ).resolves.toMatchObject({
        available: false,
        unavailableReason: "cost_limit_reached",
      });
      await expect(
        getPaidDailyFreeAllowanceStatus(eligibleContext),
      ).resolves.toMatchObject({
        available: false,
        unavailableReason: "cost_limit_reached",
      });
    });

    it("is offered only when the user is on the Auto model", async () => {
      const { getPaidDailyFreeAllowanceStatus } = getIsolatedModule();

      await expect(
        getPaidDailyFreeAllowanceStatus({
          ...agentContext,
          selectedModel: "auto",
        }),
      ).resolves.toMatchObject({ available: true });
      await expect(
        getPaidDailyFreeAllowanceStatus({
          ...agentContext,
          selectedModel: null,
        }),
      ).resolves.toMatchObject({ available: true });
      await expect(
        getPaidDailyFreeAllowanceStatus({
          ...agentContext,
          selectedModel: "hackerai-pro",
        }),
      ).resolves.toMatchObject({
        available: false,
        unavailableReason: "unsupported_model",
      });
      // Ask is untouched by the model gate.
      await expect(
        getPaidDailyFreeAllowanceStatus({
          ...eligibleContext,
          selectedModel: "hackerai-max",
        }),
      ).resolves.toMatchObject({ available: true, requestLimit: 1 });
    });

    it("still excludes free and team subscriptions", async () => {
      const { getPaidDailyFreeAllowanceStatus } = getIsolatedModule();

      await expect(
        getPaidDailyFreeAllowanceStatus({
          ...agentContext,
          subscription: "free",
        }),
      ).resolves.toMatchObject({
        available: false,
        unavailableReason: "unsupported_subscription",
      });
      await expect(
        getPaidDailyFreeAllowanceStatus({
          ...agentContext,
          subscription: "team",
        }),
      ).resolves.toMatchObject({
        available: false,
        unavailableReason: "unsupported_subscription",
      });
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

    await recordPaidDailyFreeAllowanceCost("user_123", 0.26);

    await expect(
      getPaidDailyFreeAllowanceStatus(eligibleContext),
    ).resolves.toMatchObject({
      available: false,
      unavailableReason: "cost_limit_reached",
      costUsedDollars: 0.26,
      costRemainingDollars: 0,
    });
  });

  it("reports Redis unavailable when allowance reads fail", async () => {
    const { getPaidDailyFreeAllowanceStatus } = getIsolatedModule();
    mockRedis.get.mockRejectedValueOnce(new Error("redis down"));

    await expect(
      getPaidDailyFreeAllowanceStatus(eligibleContext),
    ).resolves.toMatchObject({
      available: false,
      unavailableReason: "redis_unavailable",
    });
  });

  it("blocks rescue reservation when the Redis reservation script fails", async () => {
    const { reservePaidDailyFreeAllowanceRequest } = getIsolatedModule();
    mockRedis.eval.mockRejectedValueOnce(new Error("redis down"));

    await expect(
      reservePaidDailyFreeAllowanceRequest(eligibleContext),
    ).resolves.toMatchObject({
      allowed: false,
      blockReason: "redis_unavailable",
      status: {
        available: false,
        unavailableReason: "redis_unavailable",
      },
    });
  });

  it("returns an explicit failure when recording allowance cost fails", async () => {
    const { recordPaidDailyFreeAllowanceCost } = getIsolatedModule();
    mockRedis.eval.mockRejectedValueOnce(new Error("redis down"));

    await expect(
      recordPaidDailyFreeAllowanceCost("user_123", 0.03),
    ).resolves.toMatchObject({
      recorded: false,
      costDollars: 0.03,
      unavailableReason: "redis_unavailable",
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
