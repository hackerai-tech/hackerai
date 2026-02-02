/**
 * Tests for sliding-window rate limiting (free users).
 *
 * Uses jest.isolateModules() for fresh module instances with mocked dependencies.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

describe("sliding-window", () => {
  const mockLimitFn = jest.fn();
  const mockCreateRedisClient = jest.fn();
  const mockFormatTimeRemaining = jest.fn();

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    // Default mock responses
    mockLimitFn.mockResolvedValue({
      success: true,
      remaining: 5,
      reset: Date.now() + 3600000,
    });

    mockFormatTimeRemaining.mockReturnValue("5 hours");
  });

  const getIsolatedModule = () => {
    let isolatedModule: typeof import("../sliding-window");

    jest.isolateModules(() => {
      const MockRatelimit = jest.fn().mockImplementation(() => ({
        limit: mockLimitFn,
      }));
      (MockRatelimit as any).slidingWindow = jest.fn().mockReturnValue({});

      jest.doMock("@upstash/ratelimit", () => ({
        Ratelimit: MockRatelimit,
      }));

      jest.doMock("../redis", () => ({
        createRedisClient: mockCreateRedisClient,
        formatTimeRemaining: mockFormatTimeRemaining,
      }));

      isolatedModule = require("../sliding-window");
    });

    return isolatedModule!;
  };

  describe("checkFreeUserRateLimit", () => {
    it("should throw error when Redis unavailable", async () => {
      const { checkFreeUserRateLimit } = getIsolatedModule();

      mockCreateRedisClient.mockReturnValue(null);

      try {
        await checkFreeUserRateLimit("user-123");
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.cause).toContain("temporarily unavailable");
      }
    });

    it("should use sliding window for free users", async () => {
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
        expect(error.cause).toContain("rate limit");
        expect(error.cause).toContain("Upgrade plan");
      }
    });

    it("should include time remaining in error message", async () => {
      const { checkFreeUserRateLimit } = getIsolatedModule();

      mockCreateRedisClient.mockReturnValue({});
      mockLimitFn.mockResolvedValue({
        success: false,
        remaining: 0,
        reset: Date.now() + 3600000,
      });
      mockFormatTimeRemaining.mockReturnValue("2 hours");

      try {
        await checkFreeUserRateLimit("user-123");
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.cause).toContain("2 hours");
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
});
