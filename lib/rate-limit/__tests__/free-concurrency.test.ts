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

  it("skips the lock outside production when Redis is unavailable", async () => {
    mockCreateRedisClient.mockReturnValue(null);
    const { acquireFreeRunConcurrencyLock } = getIsolatedModule();

    const lock = await acquireFreeRunConcurrencyLock("user-123", 60);

    expect(lock.rateLimitSkipped).toBe(true);
    await expect(lock.release()).resolves.toBeUndefined();
  });
});
