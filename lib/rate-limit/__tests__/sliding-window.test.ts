/**
 * Tests for fixed-window rate limiting (free users).
 *
 * Uses jest.isolateModules() for fresh module instances with mocked dependencies.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

describe("sliding-window", () => {
  const mockEvalFn = jest.fn();
  const mockCreateRedisClient = jest.fn();

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    // Default mock responses
    mockEvalFn.mockResolvedValue([1, 5]);
  });

  const getIsolatedModule = () => {
    let isolatedModule: typeof import("../sliding-window");

    jest.isolateModules(() => {
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
      expect(mockEvalFn).not.toHaveBeenCalled();
    });

    it("should use fixed window for free users", async () => {
      const { checkFreeUserRateLimit } = getIsolatedModule();

      mockCreateRedisClient.mockReturnValue({ eval: mockEvalFn });

      const result = await checkFreeUserRateLimit("user-123");

      expect(mockEvalFn).toHaveBeenCalledWith(
        expect.any(String),
        [
          expect.stringMatching(/^free_limit:user-123:free:\d+$/),
          "free_referral_bonus:user-123",
        ],
        [10, 1, expect.any(Number)],
      );
      expect(result.remaining).toBe(5);
    });

    it("should throw ChatSDKError when rate limit exceeded", async () => {
      const { checkFreeUserRateLimit } = getIsolatedModule();

      mockCreateRedisClient.mockReturnValue({ eval: mockEvalFn });
      mockEvalFn.mockResolvedValue([0, 0]);

      try {
        await checkFreeUserRateLimit("user-123");
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.cause).toContain("daily requests");
        expect(error.cause).toContain("midnight UTC");
        expect(error.cause).toContain("Upgrade plan");
      }
    });

    it("should throw ChatSDKError on Redis errors", async () => {
      const { checkFreeUserRateLimit } = getIsolatedModule();

      mockCreateRedisClient.mockReturnValue({ eval: mockEvalFn });
      mockEvalFn.mockRejectedValue(new Error("Redis connection failed"));

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
      expect(result.remaining).toBe(10);
      expect(result.limit).toBe(10);
      expect(result.rateLimitSkipped).toBe(true);
      expect(mockEvalFn).not.toHaveBeenCalled();
    });

    it("should use the shared fixed window with a cost of 2", async () => {
      const { checkFreeAgentRateLimit } = getIsolatedModule();

      mockCreateRedisClient.mockReturnValue({ eval: mockEvalFn });

      const result = await checkFreeAgentRateLimit("user-123");

      expect(mockEvalFn).toHaveBeenCalledWith(
        expect.any(String),
        [
          expect.stringMatching(/^free_limit:user-123:free:\d+$/),
          "free_referral_bonus:user-123",
        ],
        [10, 2, expect.any(Number)],
      );
      expect(result.remaining).toBe(5);
    });

    it("should throw ChatSDKError when the shared free limit is exceeded", async () => {
      const { checkFreeAgentRateLimit } = getIsolatedModule();

      mockCreateRedisClient.mockReturnValue({ eval: mockEvalFn });
      mockEvalFn.mockResolvedValue([0, 1]);

      try {
        await checkFreeAgentRateLimit("user-123");
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.cause).toContain("daily requests");
        expect(error.cause).toContain("midnight UTC");
        expect(error.cause).toContain("Upgrade plan");
      }
    });
  });

  describe("grantFreeReferralBonusUnits", () => {
    it("should grant referral bonus request units", async () => {
      const { grantFreeReferralBonusUnits } = getIsolatedModule();

      mockCreateRedisClient.mockReturnValue({
        eval: mockEvalFn,
      });

      const result = await grantFreeReferralBonusUnits(
        "user-123",
        5,
        "referral_signup:user-123",
      );

      expect(result).toEqual({ granted: true, units: 5 });
      expect(mockEvalFn).toHaveBeenCalledWith(
        expect.any(String),
        [
          "free_referral_bonus:user-123",
          "free_referral_bonus_grant:referral_signup:user-123",
        ],
        [5, 30 * 24 * 60 * 60],
      );
    });
  });
});
