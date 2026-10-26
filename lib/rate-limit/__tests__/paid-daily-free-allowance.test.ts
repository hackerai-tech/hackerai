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
  const redisExpiry = new Map<string, number>();
  const readRedisKey = (key: string) => {
    if ((redisExpiry.get(key) ?? Infinity) <= Date.now()) {
      redisStore.delete(key);
      redisExpiry.delete(key);
    }
    return redisStore.get(key);
  };
  const originalEnv = {
    cost: process.env.PAID_DAILY_FREE_ALLOWANCE_COST_LIMIT_USD,
    nodeEnv: process.env.NODE_ENV,
  };

  const mockRedis = {
    get: jest.fn(async (key: string) => readRedisKey(key) ?? null),
    eval: jest.fn(
      async (_script: string, keys: string[], args: Array<number | string>) => {
        if (args.length === 4) {
          // Mirrors the atomic tokenized lease shared by Ask and Agent.
          const [requestsKey, costKey, reservationKey] = keys;
          const [costLimitRaw, _counterTtlMs, reservationTtlMs, token] = args;
          const costLimit = Number(costLimitRaw);
          const requestsUsed = Number(redisStore.get(requestsKey) ?? 0);
          const costUsed = Number(redisStore.get(costKey) ?? 0);
          if (costUsed >= costLimit) {
            return [0, "cost_limit_reached", requestsUsed, costUsed];
          }
          if (
            readRedisKey(reservationKey) != null ||
            (keys[3] && readRedisKey(keys[3]) != null)
          ) {
            return [0, "request_in_progress", requestsUsed, costUsed];
          }
          const nextRequests = requestsUsed + 1;
          redisStore.set(requestsKey, nextRequests);
          redisStore.set(reservationKey, String(token));
          redisExpiry.set(
            reservationKey,
            Date.now() + Number(reservationTtlMs),
          );
          if (keys[3]) {
            redisStore.set(keys[3], String(token));
            redisExpiry.set(
              keys[3],
              Date.now() +
                Math.min(Number(_counterTtlMs), Number(reservationTtlMs)),
            );
          }
          return [1, "ok", nextRequests, costUsed];
        }

        if (args.length === 3) {
          const [costKey, reservationKey] = keys;
          const [costPointsRaw, _ttlMs, token] = args;
          const costUsed = Number(redisStore.get(costKey) ?? 0);
          if (readRedisKey(reservationKey) !== String(token)) {
            return [0, costUsed];
          }
          const nextCost = costUsed + Number(costPointsRaw);
          redisStore.set(costKey, nextCost);
          redisStore.delete(reservationKey);
          redisExpiry.delete(reservationKey);
          if (keys[2] && readRedisKey(keys[2]) === String(token)) {
            redisStore.delete(keys[2]);
            redisExpiry.delete(keys[2]);
          }
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
    redisExpiry.clear();
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

  it.each([askContext, agentContext])(
    "keeps $mode on the allowance after opting in once, until the daily cap",
    async (ctx) => {
      const mod = getIsolatedModule();
      const initialStatus = await mod.getPaidDailyFreeAllowanceStatus(ctx);
      expect(mod.hasPaidDailyFreeAllowanceConsent(initialStatus)).toBe(false);
      expect(
        mod.hasPaidDailyFreeAllowanceConsent(initialStatus, {
          type: "paid_daily_free_allowance",
        }),
      ).toBe(true);

      const first = await mod.reservePaidDailyFreeAllowanceRequest(ctx);
      expect(first.allowed).toBe(true);
      await mod.recordPaidDailyFreeAllowanceCost(ctx.userId, 0.1, first);

      // A fresh process/client receives no retry option or in-memory state.
      const nextRequest = getIsolatedModule();
      const followUpStatus =
        await nextRequest.getPaidDailyFreeAllowanceStatus(ctx);
      expect(nextRequest.hasPaidDailyFreeAllowanceConsent(followUpStatus)).toBe(
        true,
      );
      const followUp =
        await nextRequest.reservePaidDailyFreeAllowanceRequest(ctx);
      expect(followUp).toMatchObject({
        allowed: true,
        status: { requestsUsed: 2, costRemainingDollars: 0.15 },
      });
      await nextRequest.recordPaidDailyFreeAllowanceCost(
        ctx.userId,
        0.15,
        followUp,
      );

      const exhausted = await nextRequest.getPaidDailyFreeAllowanceStatus(ctx);
      expect(nextRequest.hasPaidDailyFreeAllowanceConsent(exhausted)).toBe(
        true,
      );
      await expect(
        nextRequest.reservePaidDailyFreeAllowanceRequest(ctx),
      ).resolves.toMatchObject({
        allowed: false,
        blockReason: "cost_limit_reached",
      });
    },
  );

  it("shares consent across modes, isolates accounts, and resets it each UTC day", async () => {
    const mod = getIsolatedModule();
    const first = await mod.reservePaidDailyFreeAllowanceRequest(agentContext);
    // Even a canceled run with no spend should preserve the explicit choice.
    await mod.recordPaidDailyFreeAllowanceCost(agentContext.userId, 0, first);

    expect(
      mod.hasPaidDailyFreeAllowanceConsent(
        await mod.getPaidDailyFreeAllowanceStatus(askContext),
      ),
    ).toBe(true);
    expect(
      mod.hasPaidDailyFreeAllowanceConsent(
        await mod.getPaidDailyFreeAllowanceStatus({
          ...agentContext,
          userId: "another_user",
        }),
      ),
    ).toBe(false);

    jest.setSystemTime(new Date("2026-06-12T00:00:01.000Z"));
    expect(
      mod.hasPaidDailyFreeAllowanceConsent(
        await mod.getPaidDailyFreeAllowanceStatus(agentContext),
      ),
    ).toBe(false);
  });

  it("still rejects an explicit paid model after opting into the allowance", async () => {
    const mod = getIsolatedModule();
    const first = await mod.reservePaidDailyFreeAllowanceRequest(agentContext);
    await mod.recordPaidDailyFreeAllowanceCost(
      agentContext.userId,
      0.01,
      first,
    );

    await expect(
      mod.reservePaidDailyFreeAllowanceRequest({
        ...agentContext,
        selectedModel: "hackerai-standard",
      }),
    ).resolves.toMatchObject({
      allowed: false,
      blockReason: "unsupported_model",
    });
  });

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

  it("keeps an Agent lease through a six-hour run and settles before admitting a second request", async () => {
    const mod = getIsolatedModule();
    const first = await mod.reservePaidDailyFreeAllowanceRequest(agentContext);
    expect(first.allowed).toBe(true);
    const agentReservationCall = mockRedis.eval.mock.calls.find(
      ([, keys]) => keys.length === 4,
    );
    expect(agentReservationCall?.[2][2]).toBeGreaterThan(6 * 60 * 60 * 1000);

    jest.setSystemTime(new Date("2026-06-11T16:06:00.000Z"));
    await expect(
      mod.getPaidDailyFreeAllowanceStatus(askContext),
    ).resolves.toMatchObject({
      available: false,
      unavailableReason: "request_in_progress",
    });
    await expect(
      mod.reservePaidDailyFreeAllowanceRequest(askContext),
    ).resolves.toMatchObject({
      allowed: false,
      blockReason: "request_in_progress",
    });

    jest.setSystemTime(new Date("2026-06-11T18:01:00.000Z"));
    await expect(
      mod.recordPaidDailyFreeAllowanceCost("user_123", 0.2, first),
    ).resolves.toMatchObject({
      recorded: true,
      nextCostDollars: 0.2,
    });
    await expect(
      mod.reservePaidDailyFreeAllowanceRequest(askContext),
    ).resolves.toMatchObject({
      allowed: true,
      status: { costRemainingDollars: 0.05 },
    });
  });

  it("keeps an active lease across UTC midnight and charges its original day", async () => {
    const mod = getIsolatedModule();
    jest.setSystemTime(new Date("2026-06-11T23:59:00.000Z"));
    const first = await mod.reservePaidDailyFreeAllowanceRequest(agentContext);
    expect(first.allowed).toBe(true);

    jest.setSystemTime(new Date("2026-06-12T00:01:00.000Z"));
    await expect(
      mod.reservePaidDailyFreeAllowanceRequest(askContext),
    ).resolves.toMatchObject({
      allowed: false,
      blockReason: "request_in_progress",
    });
    await expect(
      mod.recordPaidDailyFreeAllowanceCost("user_123", 0.2, first),
    ).resolves.toMatchObject({
      recorded: true,
      nextCostDollars: 0.2,
    });
    const oldCostKey = mod.getPaidDailyFreeAllowanceKeys(
      "user_123",
      "2026-06-11",
    ).costKey;
    expect(readRedisKey(oldCostKey)).toBe(2_000);
    await expect(
      mod.reservePaidDailyFreeAllowanceRequest(askContext),
    ).resolves.toMatchObject({
      allowed: true,
      status: { costUsedDollars: 0 },
    });
  });

  it("recovers an abandoned lease after the maximum run and rejects late settlement", async () => {
    const mod = getIsolatedModule();
    const abandoned =
      await mod.reservePaidDailyFreeAllowanceRequest(agentContext);
    expect(abandoned.allowed).toBe(true);

    jest.setSystemTime(new Date("2026-06-11T18:06:00.000Z"));
    const replacement =
      await mod.reservePaidDailyFreeAllowanceRequest(askContext);
    expect(replacement.allowed).toBe(true);
    await expect(
      mod.recordPaidDailyFreeAllowanceCost("user_123", 0.2, abandoned),
    ).resolves.toMatchObject({
      recorded: false,
      unavailableReason: "reservation_unavailable",
    });
    await expect(
      mod.recordPaidDailyFreeAllowanceCost("user_123", 0.1, replacement),
    ).resolves.toMatchObject({ recorded: true, nextCostDollars: 0.1 });
  });

  it("respects a date-scoped lease owned by an older worker", async () => {
    const mod = getIsolatedModule();
    const { legacyReservationKey } =
      mod.getPaidDailyFreeAllowanceKeys("user_123");
    redisStore.set(legacyReservationKey, "older-worker-token");

    await expect(
      mod.reservePaidDailyFreeAllowanceRequest(askContext),
    ).resolves.toMatchObject({
      allowed: false,
      blockReason: "request_in_progress",
    });
    redisStore.delete(legacyReservationKey);
    await expect(
      mod.reservePaidDailyFreeAllowanceRequest(askContext),
    ).resolves.toMatchObject({
      allowed: true,
    });
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
