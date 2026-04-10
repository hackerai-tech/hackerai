/**
 * Tests for fixed-window rate limiting (free users).
 *
 * Uses jest.isolateModules() for fresh module instances with mocked dependencies.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

describe("sliding-window", () => {
  const mockLimitFn = jest.fn();
  const mockCreateRedisClient = jest.fn();

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    // Default mock responses
    mockLimitFn.mockResolvedValue({
      success: true,
      remaining: 5,
      reset: Date.now() + 3600000,
    });
  });

  const getIsolatedModule = () => {
    let isolatedModule: typeof import("../sliding-window");

    jest.isolateModules(() => {
      const MockRatelimit = jest.fn().mockImplementation(() => ({
        limit: mockLimitFn,
      }));
      (MockRatelimit as any).fixedWindow = jest.fn().mockReturnValue({});

      jest.doMock("@upstash/ratelimit", () => ({
        Ratelimit: MockRatelimit,
      }));

      jest.doMock("../redis", () => ({
        createRedisClient: mockCreateRedisClient,
      }));

      isolatedModule = require("../sliding-window");
    });

    return isolatedModule!;
  };

  describe("checkFreeUserRateLimit", () => {
    it("should skip rate limiting when Redis unavailable", async () => {
      const { checkFreeUserRateLimit } = getIsolatedModule();

      mockCreateRedisClient.mockReturnValue(null);

      const result = await checkFreeUserRateLimit("user-123");
      expect(result.remaining).toBe(10);
      expect(result.limit).toBe(10);
      expect(result.rateLimitSkipped).toBe(true);
      expect(mockLimitFn).not.toHaveBeenCalled();
    });

    it("should use fixed window for free users", async () => {
      const { checkFreeUserRateLimit } = getIsolatedModule();

      mockCreateRedisClient.mockReturnValue({});

      const result = await checkFreeUserRateLimit("user-123");

      expect(mockLimitFn).toHaveBeenCalled();
      expect(result.remaining).toBe(5);
    });

    it("should throw ChatSDKError when rate limit exceeded", async () => {
      const { checkFreeUserRateLimit } = getIsolatedModule();

      mockCreateRedisClient.mockReturnValue({});
      mockLimitFn.mockResolvedValue({
        success: false,
        remaining: 0,
        reset: Date.now() + 3600000,
      });

      try {
        await checkFreeUserRateLimit("user-123");
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.cause).toContain("daily responses");
        expect(error.cause).toContain("midnight UTC");
        expect(error.cause).toContain("Upgrade plan");
      }
    });

    it("should throw ChatSDKError on Redis errors", async () => {
      const { checkFreeUserRateLimit } = getIsolatedModule();

      mockCreateRedisClient.mockReturnValue({});
      mockLimitFn.mockRejectedValue(new Error("Redis connection failed"));

      try {
        await checkFreeUserRateLimit("user-123");
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.cause).toContain("Rate limiting service unavailable");
        expect(error.cause).toContain("Redis connection failed");
      }
    });
  });

  describe("checkFreeAgentRateLimit", () => {
    it("should skip rate limiting when Redis unavailable", async () => {
      const { checkFreeAgentRateLimit } = getIsolatedModule();

      mockCreateRedisClient.mockReturnValue(null);

      const result = await checkFreeAgentRateLimit("user-123");
      expect(result.remaining).toBe(5);
      expect(result.limit).toBe(5);
      expect(result.rateLimitSkipped).toBe(true);
      expect(mockLimitFn).not.toHaveBeenCalled();
    });

    it("should use fixed window for free agent users", async () => {
      const { checkFreeAgentRateLimit } = getIsolatedModule();

      mockCreateRedisClient.mockReturnValue({});

      const result = await checkFreeAgentRateLimit("user-123");

      expect(mockLimitFn).toHaveBeenCalled();
      expect(result.remaining).toBe(5);
    });

    it("should throw ChatSDKError when agent rate limit exceeded", async () => {
      const { checkFreeAgentRateLimit } = getIsolatedModule();

      mockCreateRedisClient.mockReturnValue({});
      mockLimitFn.mockResolvedValue({
        success: false,
        remaining: 0,
        reset: Date.now() + 3600000,
      });

      try {
        await checkFreeAgentRateLimit("user-123");
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.cause).toContain("daily agent responses");
        expect(error.cause).toContain("midnight UTC");
        expect(error.cause).toContain("Upgrade to Pro");
      }
    });
  });
});
