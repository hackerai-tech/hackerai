/**
 * Tests for token-bucket async functions.
 *
 * These tests use jest.isolateModules() to get fresh module instances
 * with fully mocked dependencies (Redis, Ratelimit, extra-usage).
 * No real external services are called.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

describe("token-bucket async functions", () => {
  // Mock functions we can control
  const mockLimitFn = jest.fn();
  const mockHincrbyFn = jest.fn();
  const mockHsetFn = jest.fn();
  const mockDeductFromBalance = jest.fn();
  const mockRefundToBalance = jest.fn();

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    // Default mock responses
    mockLimitFn.mockResolvedValue({
      success: true,
      remaining: 10000,
      reset: Date.now() + 3600000,
      limit: 10000,
    });
    mockHincrbyFn.mockResolvedValue(5000);
    mockHsetFn.mockResolvedValue(1);
    mockDeductFromBalance.mockResolvedValue({
      success: true,
      newBalanceDollars: 10,
      insufficientFunds: false,
      monthlyCapExceeded: false,
    });
    mockRefundToBalance.mockResolvedValue({
      success: true,
      newBalanceDollars: 10,
    });
  });

  const getIsolatedModule = () => {
    let isolatedModule: typeof import("../token-bucket");

    jest.isolateModules(() => {
      // Mock dependencies INSIDE isolateModules
      const MockRatelimit = jest.fn().mockImplementation(() => ({
        limit: mockLimitFn,
      }));
      // Add static method used by the code
      (MockRatelimit as any).tokenBucket = jest.fn().mockReturnValue({});

      jest.doMock("@upstash/ratelimit", () => ({
        Ratelimit: MockRatelimit,
      }));

      jest.doMock("@upstash/redis", () => ({
        Redis: jest.fn().mockImplementation(() => ({
          hincrby: mockHincrbyFn,
          hset: mockHsetFn,
        })),
      }));

      jest.doMock("../redis", () => ({
        createRedisClient: jest.fn(() => ({
          hincrby: mockHincrbyFn,
          hset: mockHsetFn,
        })),
        formatTimeRemaining: jest.fn(() => "5 hours"),
      }));

      jest.doMock("../../extra-usage", () => ({
        deductFromBalance: mockDeductFromBalance,
        refundToBalance: mockRefundToBalance,
      }));

      // Now require the module with fresh mocks
      isolatedModule = require("../token-bucket");
    });

    return isolatedModule!;
  };

  describe("checkTokenBucketLimit", () => {
    it("should throw error for free tier users (safety check)", async () => {
      const { checkTokenBucketLimit } = getIsolatedModule();

      try {
        await checkTokenBucketLimit("user-123", "free", 1000);
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.cause).toContain("not available on the free tier");
      }
    });

    it("should return rate limit info for paid users", async () => {
      const { checkTokenBucketLimit } = getIsolatedModule();

      const result = await checkTokenBucketLimit("user-123", "pro", 1000);

      expect(result).toHaveProperty("remaining");
      expect(result).toHaveProperty("resetTime");
      expect(result).toHaveProperty("limit");
      expect(result.pointsDeducted).toBeDefined();
      expect(mockLimitFn).toHaveBeenCalled();
    });

    it("should throw rate limit error when limits exceeded", async () => {
      const { checkTokenBucketLimit } = getIsolatedModule();

      mockLimitFn.mockResolvedValue({
        success: true,
        remaining: 0,
        reset: Date.now() + 3600000,
        limit: 8333,
      });

      try {
        await checkTokenBucketLimit("user-123", "pro", 1000);
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.cause).toContain("usage limit");
      }
    });

    it("should use extra usage when limits exceeded and balance available", async () => {
      const { checkTokenBucketLimit } = getIsolatedModule();

      mockLimitFn.mockResolvedValue({
        success: true,
        remaining: 0,
        reset: Date.now() + 3600000,
        limit: 8333,
      });

      const result = await checkTokenBucketLimit("user-123", "pro", 1000, {
        enabled: true,
        hasBalance: true,
        autoReloadEnabled: false,
      });

      expect(mockDeductFromBalance).toHaveBeenCalled();
      expect(result.extraUsagePointsDeducted).toBeGreaterThan(0);
    });

    it("should throw insufficient funds error when extra usage fails", async () => {
      const { checkTokenBucketLimit } = getIsolatedModule();

      mockLimitFn.mockResolvedValue({
        success: true,
        remaining: 0,
        reset: Date.now() + 3600000,
        limit: 8333,
      });

      mockDeductFromBalance.mockResolvedValue({
        success: false,
        newBalanceDollars: 0,
        insufficientFunds: true,
        monthlyCapExceeded: false,
      });

      try {
        await checkTokenBucketLimit("user-123", "pro", 1000, {
          enabled: true,
          hasBalance: true,
          autoReloadEnabled: false,
        });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.cause).toContain("extra usage balance is empty");
      }
    });
  });

  describe("deductUsage", () => {
    it("should deduct additional cost after processing", async () => {
      const { deductUsage } = getIsolatedModule();

      await deductUsage("user-123", "pro", 1000, 1200, 500);

      expect(mockLimitFn).toHaveBeenCalled();
    });

    it("should use extra usage when bucket depleted", async () => {
      const { deductUsage } = getIsolatedModule();

      mockLimitFn.mockResolvedValue({
        success: true,
        remaining: 0,
        reset: Date.now() + 3600000,
        limit: 8333,
      });

      await deductUsage("user-123", "pro", 1000, 1000, 1000, {
        enabled: true,
        hasBalance: true,
        autoReloadEnabled: false,
      });

      expect(mockDeductFromBalance).toHaveBeenCalled();
    });

    it("should skip deduction for free tier", async () => {
      const { deductUsage } = getIsolatedModule();

      await deductUsage("user-123", "free", 1000, 1000, 500);

      expect(mockLimitFn).not.toHaveBeenCalled();
    });

    it("should refund when provider cost is less than estimated (over-estimation)", async () => {
      const { deductUsage, calculateTokenCost } = getIsolatedModule();

      // Estimate: 10000 input tokens = 50 points
      const estimatedInputTokens = 10000;
      const estimatedCost = calculateTokenCost(estimatedInputTokens, "input");

      // Actual provider cost: $0.002 = 20 points (less than 50)
      const providerCostDollars = 0.002;

      await deductUsage(
        "user-123",
        "pro",
        estimatedInputTokens,
        5000, // actual input (ignored when provider cost provided)
        500, // actual output (ignored when provider cost provided)
        undefined,
        providerCostDollars,
      );

      // Should refund the difference (50 - 20 = 30 points)
      const expectedRefund =
        estimatedCost - Math.ceil(providerCostDollars * 10000);
      expect(mockHincrbyFn).toHaveBeenCalledWith(
        expect.stringContaining("usage:session"),
        "tokens",
        expectedRefund,
      );
      expect(mockHincrbyFn).toHaveBeenCalledWith(
        expect.stringContaining("usage:weekly"),
        "tokens",
        expectedRefund,
      );
      // Should NOT call limiter to deduct more
      expect(mockLimitFn).not.toHaveBeenCalled();
    });

    it("should refund when token-based actual cost is less than estimated", async () => {
      const { deductUsage, calculateTokenCost } = getIsolatedModule();

      // Estimate: 10000 input tokens = 50 points (pre-deducted)
      const estimatedInputTokens = 10000;
      const estimatedCost = calculateTokenCost(estimatedInputTokens, "input");

      // Actual: 2000 input + 500 output = 10 + 15 = 25 points
      const actualInputTokens = 2000;
      const actualOutputTokens = 500;
      const actualCost =
        calculateTokenCost(actualInputTokens, "input") +
        calculateTokenCost(actualOutputTokens, "output");

      await deductUsage(
        "user-123",
        "pro",
        estimatedInputTokens,
        actualInputTokens,
        actualOutputTokens,
        undefined,
        undefined, // no provider cost, use token calculation
      );

      // Should refund the difference (50 - 25 = 25 points)
      const expectedRefund = estimatedCost - actualCost;
      expect(mockHincrbyFn).toHaveBeenCalledWith(
        expect.stringContaining("usage:session"),
        "tokens",
        expectedRefund,
      );
    });

    it("should not refund or charge when actual cost equals estimated", async () => {
      const { deductUsage, calculateTokenCost } = getIsolatedModule();

      // Estimate: 1000 input tokens = 5 points
      const estimatedInputTokens = 1000;
      const estimatedCost = calculateTokenCost(estimatedInputTokens, "input");

      // Actual provider cost exactly matches: $0.0005 = 5 points
      const providerCostDollars = estimatedCost / 10000;

      await deductUsage(
        "user-123",
        "pro",
        estimatedInputTokens,
        1000,
        0,
        undefined,
        providerCostDollars,
      );

      // Should neither refund nor charge additional
      expect(mockHincrbyFn).not.toHaveBeenCalled();
      expect(mockLimitFn).not.toHaveBeenCalled();
    });

    it("should charge additional when actual cost exceeds estimated", async () => {
      const { deductUsage, calculateTokenCost } = getIsolatedModule();

      // Estimate: 1000 input tokens = 5 points (pre-deducted)
      const estimatedInputTokens = 1000;

      // Actual provider cost: $0.005 = 50 points (much more than 5)
      const providerCostDollars = 0.005;

      await deductUsage(
        "user-123",
        "pro",
        estimatedInputTokens,
        5000,
        1000,
        undefined,
        providerCostDollars,
      );

      // Should NOT refund
      expect(mockHincrbyFn).not.toHaveBeenCalled();
      // Should charge additional via limiter
      expect(mockLimitFn).toHaveBeenCalled();
    });
  });

  describe("refundUsage", () => {
    it("should refund bucket tokens via Redis hincrby", async () => {
      const { refundUsage } = getIsolatedModule();

      await refundUsage("user-123", "pro", 1000, 0);

      expect(mockHincrbyFn).toHaveBeenCalledWith(
        expect.stringContaining("usage:session"),
        "tokens",
        1000,
      );
      expect(mockHincrbyFn).toHaveBeenCalledWith(
        expect.stringContaining("usage:weekly"),
        "tokens",
        1000,
      );
    });

    it("should refund extra usage balance when provided", async () => {
      const { refundUsage } = getIsolatedModule();

      await refundUsage("user-123", "pro", 1000, 500);

      expect(mockRefundToBalance).toHaveBeenCalledWith("user-123", 500);
    });

    it("should not refund if no points deducted", async () => {
      const { refundUsage } = getIsolatedModule();

      await refundUsage("user-123", "pro", 0, 0);

      expect(mockHincrbyFn).not.toHaveBeenCalled();
      expect(mockRefundToBalance).not.toHaveBeenCalled();
    });

    it("should cap refunded tokens at bucket limit", async () => {
      const { refundUsage, getBudgetLimits } = getIsolatedModule();
      const { session: sessionLimit } = getBudgetLimits("pro");

      mockHincrbyFn.mockResolvedValue(sessionLimit + 10000);

      await refundUsage("user-123", "pro", 50000, 0);

      expect(mockHsetFn).toHaveBeenCalled();
    });
  });

  describe("end-to-end scenarios", () => {
    it("typical conversation flow: check -> deduct -> complete", async () => {
      const { checkTokenBucketLimit, deductUsage } = getIsolatedModule();

      const rateLimitInfo = await checkTokenBucketLimit(
        "user-123",
        "pro",
        2000,
      );
      expect(rateLimitInfo.pointsDeducted).toBeDefined();

      await deductUsage("user-123", "pro", 2000, 2500, 800);

      expect(mockLimitFn.mock.calls.length).toBeGreaterThan(2);
    });

    it("failed request flow: check -> error -> refund", async () => {
      const { checkTokenBucketLimit, refundUsage } = getIsolatedModule();

      const rateLimitInfo = await checkTokenBucketLimit(
        "user-123",
        "pro",
        2000,
      );
      const deducted = rateLimitInfo.pointsDeducted ?? 0;

      await refundUsage("user-123", "pro", deducted, 0);

      expect(mockHincrbyFn).toHaveBeenCalledWith(
        expect.any(String),
        "tokens",
        deducted,
      );
    });
  });
});
