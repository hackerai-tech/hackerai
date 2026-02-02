/**
 * Tests for rate limit routing logic (index.ts).
 *
 * Tests the main checkRateLimit function which routes to:
 * - Free users: sliding window (request counting)
 * - Paid users: token bucket (cost-based)
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

describe("checkRateLimit", () => {
  const mockLimitFn = jest.fn();
  const mockCheckTokenBucketLimit = jest.fn();
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

    mockCheckTokenBucketLimit.mockResolvedValue({
      remaining: 5000,
      resetTime: new Date(),
      limit: 10000,
      pointsDeducted: 100,
    });

    mockFormatTimeRemaining.mockReturnValue("5 hours");
  });

  const getIsolatedModule = () => {
    let isolatedModule: typeof import("../index");

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

      jest.doMock("../token-bucket", () => ({
        checkTokenBucketLimit: mockCheckTokenBucketLimit,
        deductUsage: jest.fn(),
        refundUsage: jest.fn(),
        calculateTokenCost: jest.fn(),
        getBudgetLimits: jest.fn(),
        getSubscriptionPrice: jest.fn(),
      }));

      isolatedModule = require("../index");
    });

    return isolatedModule!;
  };

  describe("free users", () => {
    it("should block agent mode for free users", async () => {
      const { checkRateLimit } = getIsolatedModule();

      mockCreateRedisClient.mockReturnValue({});

      try {
        await checkRateLimit("user-123", "agent", "free", 0);
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.cause).toContain("Agent mode is not available");
        expect(error.cause).toContain("free tier");
      }
    });

    it("should use sliding window for free users in ask mode", async () => {
      const { checkRateLimit } = getIsolatedModule();

      mockCreateRedisClient.mockReturnValue({});

      const result = await checkRateLimit("user-123", "ask", "free", 0);

      expect(mockLimitFn).toHaveBeenCalled();
      expect(mockCheckTokenBucketLimit).not.toHaveBeenCalled();
      expect(result.remaining).toBe(5);
    });

    it("should throw error when Redis unavailable", async () => {
      const { checkRateLimit } = getIsolatedModule();

      mockCreateRedisClient.mockReturnValue(null);

      try {
        await checkRateLimit("user-123", "ask", "free", 0);
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.cause).toContain("temporarily unavailable");
      }
    });

    it("should throw rate limit error when free limit exceeded", async () => {
      const { checkRateLimit } = getIsolatedModule();

      mockCreateRedisClient.mockReturnValue({});
      mockLimitFn.mockResolvedValue({
        success: false,
        remaining: 0,
        reset: Date.now() + 3600000,
      });

      try {
        await checkRateLimit("user-123", "ask", "free", 0);
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.cause).toContain("rate limit");
        expect(error.cause).toContain("Upgrade plan");
      }
    });
  });

  describe("paid users", () => {
    it("should use token bucket for pro users in agent mode", async () => {
      const { checkRateLimit } = getIsolatedModule();

      const result = await checkRateLimit("user-123", "agent", "pro", 1000);

      expect(mockCheckTokenBucketLimit).toHaveBeenCalledWith(
        "user-123",
        "pro",
        1000,
        undefined,
      );
      expect(result.remaining).toBe(5000);
    });

    it("should use token bucket for pro users in ask mode", async () => {
      const { checkRateLimit } = getIsolatedModule();

      const result = await checkRateLimit("user-123", "ask", "pro", 1000);

      expect(mockCheckTokenBucketLimit).toHaveBeenCalledWith(
        "user-123",
        "pro",
        1000,
        undefined,
      );
      expect(result.remaining).toBe(5000);
    });

    it("should use token bucket for ultra users", async () => {
      const { checkRateLimit } = getIsolatedModule();

      await checkRateLimit("user-123", "agent", "ultra", 2000, {
        enabled: true,
        hasBalance: true,
        autoReloadEnabled: false,
      });

      expect(mockCheckTokenBucketLimit).toHaveBeenCalledWith(
        "user-123",
        "ultra",
        2000,
        { enabled: true, hasBalance: true, autoReloadEnabled: false },
      );
    });

    it("should use token bucket for team users", async () => {
      const { checkRateLimit } = getIsolatedModule();

      await checkRateLimit("user-123", "ask", "team", 500);

      expect(mockCheckTokenBucketLimit).toHaveBeenCalledWith(
        "user-123",
        "team",
        500,
        undefined,
      );
    });

    it("should use same token bucket for both modes (shared budget)", async () => {
      const { checkRateLimit } = getIsolatedModule();

      await checkRateLimit("user-123", "agent", "pro", 1000);
      await checkRateLimit("user-123", "ask", "pro", 1000);

      // Both should call the same function with the same parameters
      expect(mockCheckTokenBucketLimit).toHaveBeenCalledTimes(2);
      expect(mockCheckTokenBucketLimit).toHaveBeenNthCalledWith(
        1,
        "user-123",
        "pro",
        1000,
        undefined,
      );
      expect(mockCheckTokenBucketLimit).toHaveBeenNthCalledWith(
        2,
        "user-123",
        "pro",
        1000,
        undefined,
      );
    });
  });
});
