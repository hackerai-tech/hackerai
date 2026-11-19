import { describe, it, expect, beforeEach, jest } from "@jest/globals";

describe("acquireFreeRunConcurrencyLock", () => {
  const mockCreateRedisClient = jest.fn();
  const mockSet = jest.fn();
  const mockEval = jest.fn();

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockSet.mockResolvedValue("OK");
    mockEval.mockResolvedValue(1);
  });

  const getIsolatedModule = () => {
    let isolatedModule: typeof import("../free-concurrency");

    jest.isolateModules(() => {
      jest.doMock("../redis", () => ({
        createRedisClient: mockCreateRedisClient,
      }));

      isolatedModule = require("../free-concurrency");
    });

    return isolatedModule!;
  };

  it("acquires a per-user Redis lock and releases it by token", async () => {
    mockCreateRedisClient.mockReturnValue({ set: mockSet, eval: mockEval });
    const { acquireFreeRunConcurrencyLock } = getIsolatedModule();

    const lock = await acquireFreeRunConcurrencyLock("user-123", 60);

    expect(mockSet).toHaveBeenCalledWith(
      "free_run_lock:user-123",
      expect.any(String),
      { nx: true, ex: 60 },
    );

    await lock.release();
    await lock.release();

    expect(mockEval).toHaveBeenCalledTimes(1);
    expect(mockEval).toHaveBeenCalledWith(
      expect.any(String),
      ["free_run_lock:user-123"],
      [expect.any(String)],
    );
  });

  it("throws a rate-limit error when another free run is active", async () => {
    mockCreateRedisClient.mockReturnValue({ set: mockSet, eval: mockEval });
    mockSet.mockResolvedValue(null);
    const { acquireFreeRunConcurrencyLock } = getIsolatedModule();

    await expect(
      acquireFreeRunConcurrencyLock("user-123", 60),
    ).rejects.toMatchObject({
      type: "rate_limit",
      surface: "chat",
      cause: expect.stringContaining("already have a free request running"),
      metadata: {
        subscription: "free",
        capReason: "free_concurrency",
        limitType: "concurrency",
        costGuardrail: false,
        paidMonthlyExhaustion: false,
        upgradeAvailable: false,
        addCreditAvailable: false,
        primaryCta: undefined,
        eligibleCtas: [],
      },
    });
  });

  it("allows release to be retried when Redis unlock fails", async () => {
    mockCreateRedisClient.mockReturnValue({ set: mockSet, eval: mockEval });
    mockEval
      .mockRejectedValueOnce(new Error("temporary redis failure"))
      .mockResolvedValueOnce(1);
    const { acquireFreeRunConcurrencyLock } = getIsolatedModule();

    const lock = await acquireFreeRunConcurrencyLock("user-123", 60);

    await expect(lock.release()).rejects.toThrow("temporary redis failure");
    await expect(lock.release()).resolves.toBeUndefined();

    expect(mockEval).toHaveBeenCalledTimes(2);
  });

  it("keeps a long free run exclusive until release and recovers after its lease", async () => {
    let nowSeconds = 0;
    let current: { token: string; expiresAt: number } | null = null;
    const redis = {
      set: jest.fn(
        async (_key: string, token: string, options: { ex: number }) => {
          if (current && current.expiresAt > nowSeconds) return null;
          current = { token, expiresAt: nowSeconds + options.ex };
          return "OK";
        },
      ),
      eval: jest.fn(
        async (_script: string, _keys: string[], args: string[]) => {
          if (current?.token !== args[0]) return 0;
          current = null;
          return 1;
        },
      ),
    };
    mockCreateRedisClient.mockReturnValue(redis);
    const { acquireFreeRunConcurrencyLock } = getIsolatedModule();
    const agentLeaseSeconds = 6 * 60 * 60 + 5 * 60;

    const first = await acquireFreeRunConcurrencyLock(
      "user-123",
      agentLeaseSeconds,
    );
    nowSeconds = 66 * 60;
    await expect(
      acquireFreeRunConcurrencyLock("user-123", agentLeaseSeconds),
    ).rejects.toMatchObject({ metadata: { capReason: "free_concurrency" } });
    nowSeconds = 6 * 60 * 60 + 4 * 60;
    await expect(
      acquireFreeRunConcurrencyLock("user-123", agentLeaseSeconds),
    ).rejects.toMatchObject({ metadata: { capReason: "free_concurrency" } });

    await first.release();
    const second = await acquireFreeRunConcurrencyLock(
      "user-123",
      agentLeaseSeconds,
    );
    nowSeconds += agentLeaseSeconds + 1;
    const successor = await acquireFreeRunConcurrencyLock(
      "user-123",
      agentLeaseSeconds,
    );
    await second.release();
    await expect(
      acquireFreeRunConcurrencyLock("user-123", agentLeaseSeconds),
    ).rejects.toMatchObject({ metadata: { capReason: "free_concurrency" } });
    await successor.release();
    await expect(
      acquireFreeRunConcurrencyLock("user-123", agentLeaseSeconds),
    ).resolves.toBeDefined();
  });

  it("skips the lock outside production when Redis is unavailable", async () => {
    mockCreateRedisClient.mockReturnValue(null);
    const { acquireFreeRunConcurrencyLock } = getIsolatedModule();

    const lock = await acquireFreeRunConcurrencyLock("user-123", 60);

    expect(lock.rateLimitSkipped).toBe(true);
    await expect(lock.release()).resolves.toBeUndefined();
  });
});
