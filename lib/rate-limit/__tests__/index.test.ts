/**
 * Tests for rate limit routing logic (index.ts).
 *
 * Tests the main checkRateLimit function which routes to:
 * - Free users: sliding window (request counting)
 * - Paid users: token bucket (cost-based)
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

describe("checkRateLimit", () => {
  const mockEvalFn = jest.fn();
  const mockCheckTokenBucketLimit = jest.fn();
  const mockCreateRedisClient = jest.fn();

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    // Default mock responses
    mockEvalFn.mockResolvedValue([1, 5]);

    mockCheckTokenBucketLimit.mockResolvedValue({
      remaining: 5000,
      resetTime: new Date(),
      limit: 10000,
      pointsDeducted: 100,
    });
  });

  const getIsolatedModule = () => {
    let isolatedModule: typeof import("../index");

    jest.isolateModules(() => {
      jest.doMock("../redis", () => ({
        createRedisClient: mockCreateRedisClient,
      }));

      jest.doMock("../token-bucket", () => ({
        POINTS_PER_DOLLAR: 10_000,
        NORMAL_USAGE_MULTIPLIER: 1.3,
        checkTokenBucketLimit: mockCheckTokenBucketLimit,
        deductUsage: jest.fn(),
        refundUsage: jest.fn(),
        calculateTokenCost: jest.fn(),
        getBudgetLimits: jest.fn(),
        getSubscriptionPrice: jest.fn(),
        billableCostDollarsToPoints: (costDollars: number) =>
          Number.isFinite(costDollars) && costDollars > 0
            ? Math.max(
                1,
                Math.ceil(Number((costDollars * 10_000 * 1.3).toFixed(6))),
              )
            : 0,
      }));

      isolatedModule = require("../index");
    });

    return isolatedModule!;
  };

  describe("free users", () => {
    it("should use the shared free rate limit with cost 2 in agent mode", async () => {
      const { checkRateLimit } = getIsolatedModule();

      mockCreateRedisClient.mockReturnValue({ eval: mockEvalFn });

      const result = await checkRateLimit("user-123", "agent", "free", 0);

      expect(mockEvalFn).toHaveBeenCalledWith(
        expect.any(String),
        [
          expect.stringMatching(/^free_limit:user-123:free:\d+$/),
          "free_referral_bonus:user-123",
        ],
        [10, 2, expect.any(Number)],
      );
      expect(mockCheckTokenBucketLimit).not.toHaveBeenCalled();
      expect(result.remaining).toBe(5);
    });

    it("should use sliding window for free users in ask mode", async () => {
      const { checkRateLimit } = getIsolatedModule();

      mockCreateRedisClient.mockReturnValue({ eval: mockEvalFn });

      const result = await checkRateLimit("user-123", "ask", "free", 0);

      expect(mockEvalFn).toHaveBeenCalledWith(
        expect.any(String),
        [
          expect.stringMatching(/^free_limit:user-123:free:\d+$/),
          "free_referral_bonus:user-123",
        ],
        [10, 1, expect.any(Number)],
      );
      expect(mockCheckTokenBucketLimit).not.toHaveBeenCalled();
      expect(result.remaining).toBe(5);
    });

    it("should use the free quota subject for free user keys when provided", async () => {
      const { checkRateLimit } = getIsolatedModule();
      const subject =
        "free_quota:v1:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

      mockCreateRedisClient.mockReturnValue({ eval: mockEvalFn });

      const result = await checkRateLimit(
        "user-123",
        "ask",
        "free",
        0,
        undefined,
        undefined,
        undefined,
        subject,
      );

      expect(mockEvalFn).toHaveBeenCalledWith(
        expect.any(String),
        [
          expect.stringMatching(/^free_limit:free_quota:v1:/),
          `free_referral_bonus:${subject}`,
        ],
        [10, 1, expect.any(Number)],
      );
      expect(result.remaining).toBe(5);
    });

    it("should skip rate limiting when Redis unavailable", async () => {
      const { checkRateLimit } = getIsolatedModule();

      mockCreateRedisClient.mockReturnValue(null);

      const result = await checkRateLimit("user-123", "ask", "free", 0);
      expect(result.remaining).toBe(10);
      expect(result.limit).toBe(10);
      expect(result.rateLimitSkipped).toBe(true);
    });

    it("should throw rate limit error when free limit exceeded", async () => {
      const { checkRateLimit } = getIsolatedModule();

      mockCreateRedisClient.mockReturnValue({ eval: mockEvalFn });
      mockEvalFn.mockResolvedValue([0, 0]);

      try {
        await checkRateLimit("user-123", "ask", "free", 0);
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.cause).toContain("daily requests");
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
        undefined,
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
        undefined,
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
        undefined,
        undefined,
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
        undefined,
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
        undefined,
        undefined,
      );
      expect(mockCheckTokenBucketLimit).toHaveBeenNthCalledWith(
        2,
        "user-123",
        "pro",
        1000,
        undefined,
        undefined,
        undefined,
      );
    });
  });
});
