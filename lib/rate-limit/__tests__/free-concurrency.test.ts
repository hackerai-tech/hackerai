import { describe, it, expect, beforeEach, jest } from "@jest/globals";

jest.mock("../free-quota-migration", () => ({
  FREE_QUOTA_ADMISSION_GUARD_SCRIPT: "",
  FREE_QUOTA_KEY_REDIRECT_SCRIPT: "",
  resolveMigratedFreeQuotaSubject: async (_redis: unknown, subject: string) =>
    subject,
}));

describe("acquireFreeRunConcurrencyLock", () => {
  const mockCreateRedisClient = jest.fn();
  const mockEval = jest.fn();

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockEval.mockResolvedValue("OK");
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
    mockCreateRedisClient.mockReturnValue({ eval: mockEval });
    const { acquireFreeRunConcurrencyLock } = getIsolatedModule();

    const lock = await acquireFreeRunConcurrencyLock("user-123", 60);

    expect(mockEval).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      ["free_run_lock:user-123"],
      [expect.any(String), 60],
    );

    await lock.release();
    await lock.release();

    expect(mockEval).toHaveBeenCalledTimes(2);
    expect(mockEval).toHaveBeenCalledWith(
      expect.any(String),
      ["free_run_lock:user-123"],
      [expect.any(String)],
    );
  });

  it("throws a rate-limit error when another free run is active", async () => {
    mockCreateRedisClient.mockReturnValue({ eval: mockEval });
    mockEval.mockResolvedValue(null);
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
    mockCreateRedisClient.mockReturnValue({ eval: mockEval });
    mockEval
      .mockResolvedValueOnce("OK")
      .mockRejectedValueOnce(new Error("temporary redis failure"))
      .mockResolvedValueOnce(1);
    const { acquireFreeRunConcurrencyLock } = getIsolatedModule();

    const lock = await acquireFreeRunConcurrencyLock("user-123", 60);

    await expect(lock.release()).rejects.toThrow("temporary redis failure");
    await expect(lock.release()).resolves.toBeUndefined();

    expect(mockEval).toHaveBeenCalledTimes(3);
  });

  it("skips the lock outside production when Redis is unavailable", async () => {
    mockCreateRedisClient.mockReturnValue(null);
    const { acquireFreeRunConcurrencyLock } = getIsolatedModule();

    const lock = await acquireFreeRunConcurrencyLock("user-123", 60);

    expect(lock.rateLimitSkipped).toBe(true);
    await expect(lock.release()).resolves.toBeUndefined();
  });
});
