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
  const redisStore = new Map<string, number | string>();
  const originalEnv = {
    cost: process.env.PAID_DAILY_FREE_ALLOWANCE_COST_LIMIT_USD,
    nodeEnv: process.env.NODE_ENV,
  };

  const mockRedis = {
    get: jest.fn(async (key: string) => redisStore.get(key) ?? null),
    eval: jest.fn(
      async (_script: string, keys: string[], args: Array<number | string>) => {
        if (keys.length === 3) {
          // Mirrors the atomic tokenized lease shared by Ask and Agent.
          const [requestsKey, costKey, reservationKey] = keys;
          const [costLimitRaw, _counterTtlMs, _reservationTtlMs, token] = args;
          const costLimit = Number(costLimitRaw);
          const requestsUsed = Number(redisStore.get(requestsKey) ?? 0);
          const costUsed = Number(redisStore.get(costKey) ?? 0);
          if (costUsed >= costLimit) {
            return [0, "cost_limit_reached", requestsUsed, costUsed];
          }
          if (redisStore.has(reservationKey)) {
            return [0, "request_in_progress", requestsUsed, costUsed];
          }
          const nextRequests = requestsUsed + 1;
          redisStore.set(requestsKey, nextRequests);
          redisStore.set(reservationKey, String(token));
          return [1, "ok", nextRequests, costUsed];
        }

        if (keys.length === 2) {
          const [costKey, reservationKey] = keys;
          const [costPointsRaw, _ttlMs, token] = args;
          const costUsed = Number(redisStore.get(costKey) ?? 0);
          if (redisStore.get(reservationKey) !== String(token)) {
            return [0, costUsed];
          }
          const nextCost = costUsed + Number(costPointsRaw);
          redisStore.set(costKey, nextCost);
          redisStore.delete(reservationKey);
          return [1, nextCost];
        }

        const [costKey] = keys;
        const [costPointsRaw] = args;
        const costPoints = Number(costPointsRaw);
        const nextCost = Number(redisStore.get(costKey) ?? 0) + costPoints;
        redisStore.set(costKey, nextCost);
        return nextCost;
      },
    ),
  };

  const getIsolatedModule = () => {
    let isolatedModule: typeof import("../paid-daily-free-allowance");

    jest.isolateModules(() => {
      jest.doMock("server-only", () => ({}), { virtual: true });
      jest.doMock("../redis", () => ({
        createRedisClient: mockCreateRedisClient,
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
    delete process.env.PAID_DAILY_FREE_ALLOWANCE_COST_LIMIT_USD;
    mockCreateRedisClient.mockReturnValue(mockRedis);
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-06-11T12:00:00.000Z"));
  });

  afterEach(() => {
    jest.useRealTimers();
    if (originalEnv.cost === undefined) {
      delete process.env.PAID_DAILY_FREE_ALLOWANCE_COST_LIMIT_USD;
    } else {
      process.env.PAID_DAILY_FREE_ALLOWANCE_COST_LIMIT_USD = originalEnv.cost;
    }
    process.env.NODE_ENV = originalEnv.nodeEnv;
  });

  const askContext = {
    userId: "user_123",
    subscription: "pro" as const,
    mode: "ask" as const,
    capReason: "monthly_exhausted" as const,
    hasAttachments: false,
  };
  const agentContext = { ...askContext, mode: "agent" as const };

  it("offers $0.25 of usage per day by default with no request cap", async () => {
    const { getPaidDailyFreeAllowanceStatus } = getIsolatedModule();

    for (const ctx of [askContext, agentContext]) {
      await expect(getPaidDailyFreeAllowanceStatus(ctx)).resolves.toMatchObject(
        {
          available: true,
          requestsUsed: 0,
          costLimitDollars: 0.25,
          costUsedDollars: 0,
          costRemainingDollars: 0.25,
          resetTimestamp: Date.parse("2026-06-12T00:00:00.000Z"),
        },
      );
    }
  });

  it("honours the cost cap override and treats 0 as disabled", async () => {
    process.env.PAID_DAILY_FREE_ALLOWANCE_COST_LIMIT_USD = "0.5";
    let mod = getIsolatedModule();
    await expect(
      mod.getPaidDailyFreeAllowanceStatus(agentContext),
    ).resolves.toMatchObject({ available: true, costLimitDollars: 0.5 });

    process.env.PAID_DAILY_FREE_ALLOWANCE_COST_LIMIT_USD = "0";
    mod = getIsolatedModule();
    await expect(
      mod.getPaidDailyFreeAllowanceStatus(agentContext),
    ).resolves.toMatchObject({ available: false, costLimitDollars: 0 });
  });

  it("covers every paid plan in both modes, never free", async () => {
    const { getPaidDailyFreeAllowanceStatus } = getIsolatedModule();

    for (const subscription of ["pro", "pro-plus", "ultra", "team"] as const) {
      for (const ctx of [askContext, agentContext]) {
        await expect(
          getPaidDailyFreeAllowanceStatus({ ...ctx, subscription }),
        ).resolves.toMatchObject({ available: true });
      }
    }
    for (const ctx of [askContext, agentContext]) {
      await expect(
        getPaidDailyFreeAllowanceStatus({ ...ctx, subscription: "free" }),
      ).resolves.toMatchObject({
        available: false,
        unavailableReason: "unsupported_subscription",
      });
    }
  });

  it("requires the monthly bucket to be exhausted", async () => {
    const { getPaidDailyFreeAllowanceStatus } = getIsolatedModule();

    await expect(
      getPaidDailyFreeAllowanceStatus({
        ...agentContext,
        capReason: "extra_usage_cap",
      }),
    ).resolves.toMatchObject({
      available: false,
      unavailableReason: "not_monthly_exhausted",
    });
  });

  it("excludes Ask attachments but keeps Agent attachments", async () => {
    const { getPaidDailyFreeAllowanceStatus } = getIsolatedModule();

    await expect(
      getPaidDailyFreeAllowanceStatus({ ...askContext, hasAttachments: true }),
    ).resolves.toMatchObject({
      available: false,
      unavailableReason: "attachments_not_supported",
    });
    await expect(
      getPaidDailyFreeAllowanceStatus({
        ...agentContext,
        hasAttachments: true,
      }),
    ).resolves.toMatchObject({ available: true });
  });

  it("is offered only when the user is on the Auto model", async () => {
    const { getPaidDailyFreeAllowanceStatus } = getIsolatedModule();

    for (const ctx of [askContext, agentContext]) {
      await expect(
        getPaidDailyFreeAllowanceStatus({ ...ctx, selectedModel: "auto" }),
      ).resolves.toMatchObject({ available: true });
      await expect(
        getPaidDailyFreeAllowanceStatus({ ...ctx, selectedModel: null }),
      ).resolves.toMatchObject({ available: true });
      await expect(
        getPaidDailyFreeAllowanceStatus({
          ...ctx,
          selectedModel: "hackerai-pro",
        }),
      ).resolves.toMatchObject({
        available: false,
        unavailableReason: "unsupported_model",
      });
    }
  });

  it("allows repeated rescues in a day and counts them", async () => {
    const {
      recordPaidDailyFreeAllowanceCost,
      reservePaidDailyFreeAllowanceRequest,
    } = getIsolatedModule();

    for (let i = 1; i <= 3; i += 1) {
      const reservation = await reservePaidDailyFreeAllowanceRequest(
        i % 2 ? agentContext : askContext,
      );
      expect(reservation).toMatchObject({
        allowed: true,
        status: { available: true, requestsUsed: i },
      });
      await expect(
        recordPaidDailyFreeAllowanceCost("user_123", 0.01, reservation),
      ).resolves.toMatchObject({ recorded: true });
    }
  });

  it("admits only one overlapping rescue across Ask and Agent", async () => {
    const {
      getPaidDailyFreeAllowanceStatus,
      recordPaidDailyFreeAllowanceCost,
      reservePaidDailyFreeAllowanceRequest,
    } = getIsolatedModule();

    const reservations = await Promise.all([
      reservePaidDailyFreeAllowanceRequest(askContext),
      reservePaidDailyFreeAllowanceRequest(agentContext),
    ]);
    const admitted = reservations.filter((reservation) => reservation.allowed);
    const blocked = reservations.filter((reservation) => !reservation.allowed);

    expect(admitted).toHaveLength(1);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({
      blockReason: "request_in_progress",
    });
    const reservationCall = mockRedis.eval.mock.calls.find(
      ([, keys]) => keys.length === 3,
    );
    expect(reservationCall?.[2][2]).toBe(14_700_000);
    await expect(
      getPaidDailyFreeAllowanceStatus(askContext),
    ).resolves.toMatchObject({
      available: false,
      unavailableReason: "request_in_progress",
    });

    await expect(
      recordPaidDailyFreeAllowanceCost("user_123", 0.1, admitted[0]),
    ).resolves.toMatchObject({ recorded: true, nextCostDollars: 0.1 });
    await expect(
      reservePaidDailyFreeAllowanceRequest(agentContext),
    ).resolves.toMatchObject({ allowed: true });
  });

  it("releases an unused lease and rejects settlement with the wrong token", async () => {
    const {
      recordPaidDailyFreeAllowanceCost,
      reservePaidDailyFreeAllowanceRequest,
    } = getIsolatedModule();
    const reservation = await reservePaidDailyFreeAllowanceRequest(askContext);
    expect(reservation.allowed).toBe(true);

    const wrongReservation = {
      ...reservation,
      redisReservation: {
        ...reservation.redisReservation!,
        token: "wrong-token",
      },
    };
    await expect(
      recordPaidDailyFreeAllowanceCost("user_123", 0, wrongReservation),
    ).resolves.toMatchObject({
      recorded: false,
      unavailableReason: "reservation_unavailable",
    });
    await expect(
      reservePaidDailyFreeAllowanceRequest(agentContext),
    ).resolves.toMatchObject({ allowed: false });

    await expect(
      recordPaidDailyFreeAllowanceCost("user_123", 0, reservation),
    ).resolves.toMatchObject({ recorded: true, nextCostDollars: 0 });
    await expect(
      reservePaidDailyFreeAllowanceRequest(agentContext),
    ).resolves.toMatchObject({ allowed: true });
  });

  it("shares one daily cost pool between Ask and Agent and blocks at the cap", async () => {
    const {
      getPaidDailyFreeAllowanceStatus,
      reservePaidDailyFreeAllowanceRequest,
      recordPaidDailyFreeAllowanceCost,
    } = getIsolatedModule();

    await recordPaidDailyFreeAllowanceCost("user_123", 0.1);
    await expect(
      getPaidDailyFreeAllowanceStatus(agentContext),
    ).resolves.toMatchObject({
      available: true,
      costUsedDollars: 0.1,
      costRemainingDollars: 0.15,
    });

    await recordPaidDailyFreeAllowanceCost("user_123", 0.16);
    for (const ctx of [askContext, agentContext]) {
      await expect(getPaidDailyFreeAllowanceStatus(ctx)).resolves.toMatchObject(
        {
          available: false,
          unavailableReason: "cost_limit_reached",
          costUsedDollars: 0.26,
          costRemainingDollars: 0,
        },
      );
      await expect(
        reservePaidDailyFreeAllowanceRequest(ctx),
      ).resolves.toMatchObject({
        allowed: false,
        blockReason: "cost_limit_reached",
      });
    }
  });

  it("reports Redis unavailable when allowance reads fail", async () => {
    const { getPaidDailyFreeAllowanceStatus } = getIsolatedModule();
    mockRedis.get.mockRejectedValueOnce(new Error("redis down"));

    await expect(
      getPaidDailyFreeAllowanceStatus(agentContext),
    ).resolves.toMatchObject({
      available: false,
      unavailableReason: "redis_unavailable",
    });
  });

  it("blocks rescue reservation when the Redis reservation script fails", async () => {
    const { reservePaidDailyFreeAllowanceRequest } = getIsolatedModule();
    mockRedis.eval.mockRejectedValueOnce(new Error("redis down"));

    await expect(
      reservePaidDailyFreeAllowanceRequest(agentContext),
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
      recordPaidDailyFreeAllowanceCost,
      reservePaidDailyFreeAllowanceRequest,
    } = getIsolatedModule();

    jest.setSystemTime(new Date("2026-06-11T23:59:00.000Z"));
    const reservation =
      await reservePaidDailyFreeAllowanceRequest(agentContext);
    await recordPaidDailyFreeAllowanceCost("user_123", 0.25, reservation);
    const june11Keys = getPaidDailyFreeAllowanceKeys("user_123", "2026-06-11");
    expect(redisStore.get(june11Keys.requestsKey)).toBe(1);
    await expect(
      getPaidDailyFreeAllowanceStatus(agentContext),
    ).resolves.toMatchObject({ available: false });

    jest.setSystemTime(new Date("2026-06-12T00:00:01.000Z"));
    const june12Status = await getPaidDailyFreeAllowanceStatus(agentContext);
    const june12Keys = getPaidDailyFreeAllowanceKeys("user_123", "2026-06-12");

    expect(june12Status).toMatchObject({
      available: true,
      requestsUsed: 0,
      costUsedDollars: 0,
      resetTimestamp: Date.parse("2026-06-13T00:00:00.000Z"),
    });
    expect(redisStore.get(june12Keys.requestsKey)).toBeUndefined();
  });
});
