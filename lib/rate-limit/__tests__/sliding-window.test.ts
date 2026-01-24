/**
 * Tests for sliding-window rate limiting (ask mode).
 *
 * Uses jest.isolateModules() for fresh module instances with mocked dependencies.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

describe("sliding-window", () => {
  const mockLimitFn = jest.fn();
  const mockCheckAgentRateLimit = jest.fn();
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

    mockCheckAgentRateLimit.mockResolvedValue({
      remaining: 5000,
      resetTime: new Date(),
      limit: 10000,
      pointsDeducted: 100,
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

      jest.doMock("../token-bucket", () => ({
        checkAgentRateLimit: mockCheckAgentRateLimit,
      }));

      isolatedModule = require("../sliding-window");
    });

    return isolatedModule!;
  };

  describe("checkAskRateLimit", () => {
    describe("paid users (delegate to token bucket)", () => {
      it("should delegate pro users to checkAgentRateLimit", async () => {
        const { checkAskRateLimit } = getIsolatedModule();

        const result = await checkAskRateLimit("user-123", "pro", 1000);

        expect(mockCheckAgentRateLimit).toHaveBeenCalledWith(
          "user-123",
          "pro",
          1000,
          undefined,
        );
        expect(result.remaining).toBe(5000);
        expect(result.pointsDeducted).toBe(100);
      });

      it("should delegate ultra users to checkAgentRateLimit", async () => {
        const { checkAskRateLimit } = getIsolatedModule();

        await checkAskRateLimit("user-123", "ultra", 2000, {
          enabled: true,
          hasBalance: true,
          autoReloadEnabled: false,
        });

        expect(mockCheckAgentRateLimit).toHaveBeenCalledWith(
          "user-123",
          "ultra",
          2000,
          { enabled: true, hasBalance: true, autoReloadEnabled: false },
        );
      });

      it("should delegate team users to checkAgentRateLimit", async () => {
        const { checkAskRateLimit } = getIsolatedModule();

        await checkAskRateLimit("user-123", "team", 500);

        expect(mockCheckAgentRateLimit).toHaveBeenCalledWith(
          "user-123",
          "team",
          500,
          undefined,
        );
      });
    });

    describe("free users (sliding window)", () => {
      it("should return high limit fallback when Redis unavailable", async () => {
        const { checkAskRateLimit } = getIsolatedModule();

        mockCreateRedisClient.mockReturnValue(null);

        const result = await checkAskRateLimit("user-123", "free", 0);

        expect(result.remaining).toBe(999);
        expect(result.limit).toBe(999);
        expect(mockLimitFn).not.toHaveBeenCalled();
      });

      it("should use sliding window for free users", async () => {
        const { checkAskRateLimit } = getIsolatedModule();

        mockCreateRedisClient.mockReturnValue({});

        const result = await checkAskRateLimit("user-123", "free", 0);

        expect(mockLimitFn).toHaveBeenCalled();
        expect(result.remaining).toBe(5);
      });

      it("should throw ChatSDKError when rate limit exceeded", async () => {
        const { checkAskRateLimit } = getIsolatedModule();

        mockCreateRedisClient.mockReturnValue({});
        mockLimitFn.mockResolvedValue({
          success: false,
          remaining: 0,
          reset: Date.now() + 3600000,
        });

        try {
          await checkAskRateLimit("user-123", "free", 0);
          expect.fail("Should have thrown");
        } catch (error: any) {
          expect(error.cause).toContain("rate limit");
          expect(error.cause).toContain("Upgrade plan");
        }
      });

      it("should include time remaining in error message", async () => {
        const { checkAskRateLimit } = getIsolatedModule();

        mockCreateRedisClient.mockReturnValue({});
        mockLimitFn.mockResolvedValue({
          success: false,
          remaining: 0,
          reset: Date.now() + 3600000,
        });
        mockFormatTimeRemaining.mockReturnValue("2 hours");

        try {
          await checkAskRateLimit("user-123", "free", 0);
          expect.fail("Should have thrown");
        } catch (error: any) {
          expect(error.cause).toContain("2 hours");
        }
      });
    });

    describe("error handling", () => {
      it("should throw ChatSDKError on Redis errors", async () => {
        const { checkAskRateLimit } = getIsolatedModule();

        mockCreateRedisClient.mockReturnValue({});
        mockLimitFn.mockRejectedValue(new Error("Redis connection failed"));

        try {
          await checkAskRateLimit("user-123", "free", 0);
          expect.fail("Should have thrown");
        } catch (error: any) {
          expect(error.cause).toContain("Rate limiting service unavailable");
          expect(error.cause).toContain("Redis connection failed");
        }
      });

      it("should re-throw ChatSDKError from checkAgentRateLimit", async () => {
        const { checkAskRateLimit } = getIsolatedModule();

        const originalError = new Error("usage limit");
        (originalError as any).cause = "You've reached your usage limit";
        mockCheckAgentRateLimit.mockRejectedValue(originalError);

        try {
          await checkAskRateLimit("user-123", "pro", 1000);
          expect.fail("Should have thrown");
        } catch (error: any) {
          expect(error.cause).toContain("usage limit");
        }
      });
    });
  });
});
