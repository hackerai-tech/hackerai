/**
 * Tests for token-bucket async functions.
 *
 * These tests use jest.isolateModules() to get fresh module instances
 * with fully mocked dependencies (Redis, Ratelimit, extra-usage).
 * No real external services are called.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

describe("token-bucket async functions", () => {
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
      reset: Date.now() + 2592000000, // 30 days
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
      const MockRatelimit = jest.fn().mockImplementation(() => ({
        limit: mockLimitFn,
      }));
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
      expect(result.amountDeducted).toBeDefined();
      expect(mockLimitFn).toHaveBeenCalled();
    });

    it("should throw rate limit error when limits exceeded", async () => {
      const { checkTokenBucketLimit } = getIsolatedModule();

      mockLimitFn.mockResolvedValue({
        success: true,
        remaining: 0,
        reset: Date.now() + 2592000000,
        limit: 25_000_000,
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
        reset: Date.now() + 2592000000,
        limit: 25_000_000,
      });

      const result = await checkTokenBucketLimit("user-123", "pro", 1000, {
        enabled: true,
        hasBalance: true,
        autoReloadEnabled: false,
      });

      expect(mockDeductFromBalance).toHaveBeenCalled();
      expect(result.extraUsageAmountDeducted).toBeGreaterThan(0);
    });

    it("should throw insufficient funds error when extra usage fails", async () => {
      const { checkTokenBucketLimit } = getIsolatedModule();

      mockLimitFn.mockResolvedValue({
        success: true,
        remaining: 0,
        reset: Date.now() + 2592000000,
        limit: 25_000_000,
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
        reset: Date.now() + 2592000000,
        limit: 25_000_000,
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

      const estimatedInputTokens = 10000;
      const estimatedCost = calculateTokenCost(estimatedInputTokens, "input");
      const providerCostDollars = 0.002;

      await deductUsage(
        "user-123",
        "pro",
        estimatedInputTokens,
        5000,
        500,
        undefined,
        providerCostDollars,
      );

      const expectedRefundMicro = Math.ceil(
        (estimatedCost - providerCostDollars) * 1_000_000,
      );
      expect(mockHincrbyFn).toHaveBeenCalledWith(
        expect.stringContaining("usage:monthly"),
        "tokens",
        expectedRefundMicro,
      );
      expect(mockLimitFn).not.toHaveBeenCalled();
    });

    it("should refund when token-based actual cost is less than estimated", async () => {
      const { deductUsage, calculateTokenCost } = getIsolatedModule();

      const estimatedInputTokens = 10000;
      const estimatedCost = calculateTokenCost(estimatedInputTokens, "input");

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
        undefined,
      );

      const expectedRefundMicro = Math.ceil(
        (estimatedCost - actualCost) * 1_000_000,
      );
      expect(mockHincrbyFn).toHaveBeenCalledWith(
        expect.stringContaining("usage:monthly"),
        "tokens",
        expectedRefundMicro,
      );
    });

    it("should not refund or charge when actual cost equals estimated", async () => {
      const { deductUsage, calculateTokenCost } = getIsolatedModule();

      const estimatedInputTokens = 1000;
      const estimatedCost = calculateTokenCost(estimatedInputTokens, "input");
      const providerCostDollars = estimatedCost;

      await deductUsage(
        "user-123",
        "pro",
        estimatedInputTokens,
        1000,
        0,
        undefined,
        providerCostDollars,
      );

      expect(mockHincrbyFn).not.toHaveBeenCalled();
      expect(mockLimitFn).not.toHaveBeenCalled();
    });

    it("should charge additional when actual cost exceeds estimated", async () => {
      const { deductUsage } = getIsolatedModule();

      const estimatedInputTokens = 1000;
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

      expect(mockHincrbyFn).not.toHaveBeenCalled();
      expect(mockLimitFn).toHaveBeenCalled();
    });
  });

  describe("refundUsage", () => {
    it("should refund bucket tokens via Redis hincrby (converted to microdollars)", async () => {
      const { refundUsage } = getIsolatedModule();

      await refundUsage("user-123", "pro", 1.0, 0);

      expect(mockHincrbyFn).toHaveBeenCalledWith(
        expect.stringContaining("usage:monthly"),
        "tokens",
        1_000_000,
      );
    });

    it("should refund extra usage balance when provided (in dollars)", async () => {
      const { refundUsage } = getIsolatedModule();

      await refundUsage("user-123", "pro", 1.0, 0.5);

      expect(mockRefundToBalance).toHaveBeenCalledWith("user-123", 0.5);
    });

    it("should not refund if no amount deducted", async () => {
      const { refundUsage } = getIsolatedModule();

      await refundUsage("user-123", "pro", 0, 0);

      expect(mockHincrbyFn).not.toHaveBeenCalled();
      expect(mockRefundToBalance).not.toHaveBeenCalled();
    });

    it("should cap refunded tokens at bucket limit", async () => {
      const { refundUsage, getBudgetLimit } = getIsolatedModule();
      const monthlyLimit = getBudgetLimit("pro");
      const monthlyLimitMicro = Math.ceil(monthlyLimit * 1_000_000);

      mockHincrbyFn.mockResolvedValue(monthlyLimitMicro + 1_000_000);

      await refundUsage("user-123", "pro", 5.0, 0);

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
      expect(rateLimitInfo.amountDeducted).toBeDefined();

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
      const deducted = rateLimitInfo.amountDeducted ?? 0;

      await refundUsage("user-123", "pro", deducted, 0);

      const deductedMicro = Math.ceil(deducted * 1_000_000);
      expect(mockHincrbyFn).toHaveBeenCalledWith(
        expect.any(String),
        "tokens",
        deductedMicro,
      );
    });
  });
});
