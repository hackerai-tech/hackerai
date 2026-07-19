/**
 * Tests for token-bucket async functions.
 *
 * These tests use jest.isolateModules() to get fresh module instances
 * with fully mocked dependencies (Redis, Ratelimit, extra-usage).
 * No real external services are called.
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";

describe("token-bucket async functions", () => {
  // Mock functions we can control
  const mockCreateRedisClient = jest.fn();
  const mockLimitFn = jest.fn();
  const mockHincrbyFn = jest.fn();
  const mockHgetFn = jest.fn();
  const mockHsetFn = jest.fn();
  const mockExistsFn = jest.fn();
  const mockEvalFn = jest.fn();
  const mockDelFn = jest.fn();
  const mockSetFn = jest.fn();
  const mockExpireFn = jest.fn();
  const mockScanFn = jest.fn();
  const mockDeductFromBalance = jest.fn();
  const mockRefundToBalance = jest.fn();
  const mockDeductFromTeamBalance = jest.fn();
  const mockRefundToTeamBalance = jest.fn();
  const originalNodeEnv = process.env.NODE_ENV;

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
    mockHgetFn.mockResolvedValue(null);
    mockHsetFn.mockResolvedValue(1);
    mockExistsFn.mockResolvedValue(1);
    mockEvalFn.mockResolvedValue([-1, -1, 0]);
    mockDelFn.mockResolvedValue(1);
    mockSetFn.mockResolvedValue("OK");
    mockExpireFn.mockResolvedValue(1);
    mockScanFn.mockResolvedValue(["0", []]);
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
    mockDeductFromTeamBalance.mockResolvedValue({
      success: true,
      newBalanceDollars: 10,
      insufficientFunds: false,
      monthlyCapExceeded: false,
    });
    mockRefundToTeamBalance.mockResolvedValue({
      success: true,
      newBalanceDollars: 10,
    });
    mockCreateRedisClient.mockReturnValue({
      hincrby: mockHincrbyFn,
      hget: mockHgetFn,
      hset: mockHsetFn,
      exists: mockExistsFn,
      eval: mockEvalFn,
      del: mockDelFn,
      set: mockSetFn,
      expire: mockExpireFn,
      scan: mockScanFn,
    });
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
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
          hget: mockHgetFn,
          hset: mockHsetFn,
          exists: mockExistsFn,
          eval: mockEvalFn,
          del: mockDelFn,
          set: mockSetFn,
          expire: mockExpireFn,
          scan: mockScanFn,
        })),
      }));

      jest.doMock("../redis", () => ({
        createRedisClient: mockCreateRedisClient,
        formatTimeRemaining: jest.fn(() => "5 hours"),
      }));

      jest.doMock("../../extra-usage", () => ({
        deductFromBalance: mockDeductFromBalance,
        refundToBalance: mockRefundToBalance,
        deductFromTeamBalance: mockDeductFromTeamBalance,
        refundToTeamBalance: mockRefundToTeamBalance,
      }));

      // Now require the module with fresh mocks
      isolatedModule = require("../token-bucket");
    });

    return isolatedModule!;
  };

  describe("deleteUserRateLimitKeys", () => {
    it("does not delete identity-scoped free quota keys during account deletion", async () => {
      const { deleteUserRateLimitKeys } = getIsolatedModule();
      const identitySubject =
        "free_quota:v1:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
      mockScanFn.mockResolvedValue([
        "0",
        [
          "usage:monthly:user-123:pro",
          `free_monthly_cost:${identitySubject}:2026-06`,
          `free_limit:${identitySubject}:free:123`,
          `free_referral_bonus:${identitySubject}`,
        ],
      ]);

      await expect(deleteUserRateLimitKeys("user-123")).resolves.toBe(1);

      expect(mockDelFn).toHaveBeenCalledWith("usage:monthly:user-123:pro");
    });
  });

  describe("tier-change bucket migration", () => {
    const identity = {
      subscriptionId: "sub_upgrade",
      targetTier: "pro-plus" as const,
      transitionId: "in_upgrade",
    };

    const tierChangeState = (overrides: Record<string, unknown> = {}) =>
      JSON.stringify({
        version: 3,
        oldTier: "pro",
        targetTier: "pro-plus",
        subscriptionId: "sub_upgrade",
        transitionId: "in_upgrade",
        remaining: 0,
        cycleAllocation: 250_000,
        resetAtMs: Date.now() + 12 * 24 * 60 * 60 * 1000,
        ...overrides,
      });

    it("atomically stashes the real cycle state and deletes the old bucket", async () => {
      const resetAtMs = Date.now() + 12 * 24 * 60 * 60 * 1000;
      const state = tierChangeState({ resetAtMs });
      mockLimitFn.mockResolvedValueOnce({
        success: true,
        remaining: 0,
        reset: resetAtMs,
        limit: 250_000,
      });
      mockEvalFn.mockResolvedValueOnce(state);
      const { stashTierChangeBucketState } = getIsolatedModule();

      await expect(
        stashTierChangeBucketState("user-123", "pro", { identity }),
      ).resolves.toEqual(JSON.parse(state));

      expect(mockLimitFn).toHaveBeenCalledWith("user-123:pro", { rate: 0 });
      expect(mockEvalFn).toHaveBeenCalledWith(
        expect.stringContaining('redis.call("SET", stashKey'),
        [
          "usage:monthly:user-123:pro",
          "upgrade:carryover:user-123:in_upgrade",
          "upgrade:carryover:user-123:in_upgrade:completed",
        ],
        [
          250_000,
          resetAtMs,
          "pro",
          86_400,
          "sub_upgrade",
          "pro-plus",
          "in_upgrade",
        ],
      );
    });

    it("uses a price-specific old-cycle allocation when metadata is absent", async () => {
      const resetAtMs = Date.now() + 12 * 24 * 60 * 60 * 1000;
      mockLimitFn.mockResolvedValueOnce({
        success: true,
        remaining: 50_000,
        reset: resetAtMs,
        limit: 250_000,
      });
      mockEvalFn.mockResolvedValueOnce(
        tierChangeState({
          remaining: 50_000,
          cycleAllocation: 200_000,
          resetAtMs,
        }),
      );
      const { stashTierChangeBucketState } = getIsolatedModule();

      await stashTierChangeBucketState("user-123", "pro", {
        identity,
        oldCycleAllocationPoints: 200_000,
      });

      expect(mockEvalFn).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        [
          200_000,
          resetAtMs,
          "pro",
          86_400,
          "sub_upgrade",
          "pro-plus",
          "in_upgrade",
        ],
      );
    });

    it("applies only the prorated Pro→Pro+ difference and preserves reset", async () => {
      const resetAtMs = Date.now() + 12 * 24 * 60 * 60 * 1000;
      const periodEndSeconds = Math.ceil(resetAtMs / 1000);
      mockEvalFn
        .mockResolvedValueOnce(tierChangeState({ resetAtMs }))
        .mockResolvedValueOnce([1, 145_535]);
      const { applyProratedTierChangeBucket } = getIsolatedModule();

      const result = await applyProratedTierChangeBucket(
        "user-123",
        "pro-plus",
        {
          identity,
          proratedRatio: 0.41581478,
          periodEndSeconds,
        },
      );

      expect(result).toMatchObject({
        consumedCredits: 250_000,
        incrementalCredits: 145_535,
        cycleAllocation: 395_535,
        remainingCredits: 145_535,
        proratedRatio: 0.41581478,
      });
      expect(mockEvalFn).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('redis.call("DEL", stashKey, claimKey)'),
        [
          "usage:monthly:user-123:pro-plus",
          "upgrade:carryover:user-123:in_upgrade",
          "upgrade:carryover:user-123:in_upgrade:claim",
          "upgrade:carryover:user-123:in_upgrade:completed",
        ],
        expect.arrayContaining([
          tierChangeState({ resetAtMs }),
          145_535,
          395_535,
          600_000,
        ]),
      );
      expect(mockLimitFn).not.toHaveBeenCalled();
      expect(mockHsetFn).not.toHaveBeenCalled();
    });

    it("does not create credits when no tier-change state exists", async () => {
      mockEvalFn.mockResolvedValueOnce(null);
      const { applyProratedTierChangeBucket } = getIsolatedModule();

      await expect(
        applyProratedTierChangeBucket("user-123", "pro-plus", {
          identity,
          proratedRatio: 0.5,
        }),
      ).resolves.toBeNull();

      expect(mockDelFn).not.toHaveBeenCalled();
      expect(mockLimitFn).not.toHaveBeenCalled();
    });

    it("does not let a delayed proration overwrite a newer cycle", async () => {
      mockEvalFn.mockResolvedValueOnce(
        tierChangeState({
          resetAtMs: Date.now() - 1_000,
        }),
      );
      const { applyProratedTierChangeBucket } = getIsolatedModule();

      await expect(
        applyProratedTierChangeBucket("user-123", "pro-plus", {
          identity,
          periodEndSeconds: Math.floor(Date.now() / 1000) + 12 * 24 * 60 * 60,
        }),
      ).resolves.toBeNull();

      expect(mockDelFn).not.toHaveBeenCalled();
      expect(mockLimitFn).not.toHaveBeenCalled();
    });

    it("retains the stash and claim when the atomic replacement fails", async () => {
      const state = tierChangeState({
        remaining: 80_000,
      });
      mockEvalFn
        .mockResolvedValueOnce(state)
        .mockRejectedValueOnce(new Error("redis write failed"));
      const { applyProratedTierChangeBucket } = getIsolatedModule();

      await expect(
        applyProratedTierChangeBucket("user-123", "pro-plus", {
          identity,
          proratedRatio: 1 / 3,
        }),
      ).rejects.toThrow("redis write failed");

      expect(mockSetFn).not.toHaveBeenCalled();
      expect(mockDelFn).not.toHaveBeenCalled();
    });

    it("does not let a different Stripe transition consume the stash", async () => {
      mockEvalFn.mockResolvedValueOnce(tierChangeState());
      const { applyProratedTierChangeBucket } = getIsolatedModule();

      await expect(
        applyProratedTierChangeBucket("user-123", "pro-plus", {
          identity: { ...identity, subscriptionId: "sub_other" },
          proratedRatio: 0.5,
        }),
      ).resolves.toBeNull();

      expect(mockEvalFn).toHaveBeenCalledTimes(1);
      expect(mockLimitFn).not.toHaveBeenCalled();
    });
  });

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

    it("should skip paid rate limiting outside production when Redis is unavailable", async () => {
      mockCreateRedisClient.mockReturnValue(null);
      const { checkTokenBucketLimit } = getIsolatedModule();

      const result = await checkTokenBucketLimit("user-123", "pro", 1000);

      expect(result.rateLimitSkipped).toBe(true);
      expect(result.remaining).toBe(result.limit);
      expect(mockLimitFn).not.toHaveBeenCalled();
    });

    it("should fail closed for paid users in production when Redis is unavailable", async () => {
      process.env.NODE_ENV = "production";
      mockCreateRedisClient.mockReturnValue(null);
      const { checkTokenBucketLimit } = getIsolatedModule();

      await expect(
        checkTokenBucketLimit("user-123", "pro", 1000),
      ).rejects.toMatchObject({
        type: "rate_limit",
        surface: "chat",
        cause: "Rate limiting service is not configured",
      });
      expect(mockLimitFn).not.toHaveBeenCalled();
    });

    it("should throw rate limit error when limits exceeded", async () => {
      const { checkTokenBucketLimit } = getIsolatedModule();

      mockLimitFn.mockResolvedValue({
        success: true,
        remaining: 0,
        reset: Date.now() + 3600000,
        limit: 250000,
      });

      try {
        await checkTokenBucketLimit("user-123", "pro", 1000);
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.cause).toContain("usage limit");
        expect(error.metadata).toMatchObject({
          capReason: "monthly_exhausted",
          paidMonthlyExhaustion: true,
          addCreditAvailable: true,
          primaryCta: "add_credits",
          eligibleCtas: ["add_credits", "upgrade_plan"],
        });
      }
    });

    it("should use extra usage when limits exceeded and balance available", async () => {
      const { checkTokenBucketLimit } = getIsolatedModule();

      mockLimitFn.mockResolvedValue({
        success: true,
        remaining: 0,
        reset: Date.now() + 3600000,
        limit: 250000,
      });

      const result = await checkTokenBucketLimit("user-123", "pro", 1000, {
        enabled: true,
        hasBalance: true,
        autoReloadEnabled: false,
      });

      expect(mockDeductFromBalance).toHaveBeenCalled();
      expect(result.extraUsagePointsDeducted).toBeGreaterThan(0);
    });

    it("should return monthly nested field matching top-level fields", async () => {
      const { checkTokenBucketLimit } = getIsolatedModule();

      const result = await checkTokenBucketLimit("user-123", "pro", 1000);

      expect(result.monthly).toBeDefined();
      expect(result.monthly!.remaining).toBe(result.remaining);
      expect(result.monthly!.limit).toBe(result.limit);
      expect(result.monthly!.resetTime).toEqual(result.resetTime);
    });

    it("enforces a stored price-specific cycle allocation", async () => {
      const { checkTokenBucketLimit } = getIsolatedModule();
      mockEvalFn.mockResolvedValue([200_000, 200_000, 50_000]);
      mockLimitFn
        .mockResolvedValueOnce({
          success: true,
          remaining: 250_000,
          reset: Date.now() + 3600000,
          limit: 250_000,
        })
        .mockResolvedValueOnce({
          success: true,
          remaining: 199_993,
          reset: Date.now() + 3600000,
          limit: 250_000,
        });

      const result = await checkTokenBucketLimit("user-123", "pro", 1000);

      expect(mockEvalFn).toHaveBeenCalledWith(
        expect.any(String),
        ["usage:monthly:user-123:pro"],
        [],
      );
      expect(mockLimitFn).toHaveBeenCalledTimes(2);
      expect(result.limit).toBe(200_000);
      expect(result.monthly?.limit).toBe(200_000);
    });

    it("should throw when the final monthly deduction fails after a successful peek", async () => {
      const { checkTokenBucketLimit } = getIsolatedModule();

      mockLimitFn
        .mockResolvedValueOnce({
          success: true,
          remaining: 7,
          reset: Date.now() + 3600000,
          limit: 250000,
        })
        .mockResolvedValueOnce({
          success: false,
          remaining: 0,
          reset: Date.now() + 3600000,
          limit: 250000,
        });

      try {
        await checkTokenBucketLimit("user-123", "pro", 1000);
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.cause).toContain("monthly usage limit");
      }
    });

    it("should throw monthly cap exceeded error when extra usage cap hit", async () => {
      const { checkTokenBucketLimit } = getIsolatedModule();

      mockLimitFn.mockResolvedValue({
        success: true,
        remaining: 0,
        reset: Date.now() + 3600000,
        limit: 250000,
      });

      mockDeductFromBalance.mockResolvedValue({
        success: false,
        newBalanceDollars: 0,
        insufficientFunds: true,
        monthlyCapExceeded: true,
      });

      try {
        await checkTokenBucketLimit("user-123", "pro", 1000, {
          enabled: true,
          hasBalance: true,
          autoReloadEnabled: false,
        });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.cause).toContain("monthly extra usage spending limit");
        expect(error.metadata).toMatchObject({
          capReason: "extra_usage_cap",
          costGuardrail: true,
          addCreditAvailable: false,
          primaryCta: "increase_spending_limit",
          eligibleCtas: ["increase_spending_limit"],
        });
      }
    });

    it("should throw insufficient funds error when extra usage fails", async () => {
      const { checkTokenBucketLimit } = getIsolatedModule();

      mockLimitFn.mockResolvedValue({
        success: true,
        remaining: 0,
        reset: Date.now() + 3600000,
        limit: 250000,
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

    it("should skip usage deduction outside production when Redis is unavailable", async () => {
      mockCreateRedisClient.mockReturnValue(null);
      const { deductUsage } = getIsolatedModule();

      await expect(
        deductUsage("user-123", "pro", 1000, 1200, 500),
      ).resolves.toEqual({
        includedPointsDeducted: 0,
        extraUsagePointsDeducted: 0,
        uncoveredPoints: 0,
        usageDeductionFailed: false,
      });
      expect(mockLimitFn).not.toHaveBeenCalled();
    });

    it("should fail closed for paid usage deduction in production when Redis is unavailable", async () => {
      process.env.NODE_ENV = "production";
      mockCreateRedisClient.mockReturnValue(null);
      const { deductUsage } = getIsolatedModule();

      await expect(
        deductUsage("user-123", "pro", 1000, 1200, 500),
      ).rejects.toMatchObject({
        type: "rate_limit",
        surface: "chat",
        cause: "Rate limiting service is not configured",
      });
      expect(mockLimitFn).not.toHaveBeenCalled();
    });

    it("should use extra usage when bucket depleted", async () => {
      const { deductUsage } = getIsolatedModule();

      // Atomic deduction goes negative when bucket is depleted
      mockLimitFn.mockResolvedValue({
        success: true,
        remaining: -30,
        reset: Date.now() + 3600000,
        limit: 250000,
      });

      await deductUsage("user-123", "pro", 1000, 1000, 1000, {
        enabled: true,
        hasBalance: true,
        autoReloadEnabled: false,
      });

      expect(mockDeductFromBalance).toHaveBeenCalledWith(
        "user-123",
        42,
        undefined,
      );
    });

    it("forwards a settlement ID to the extra usage deduction", async () => {
      const { deductUsage } = getIsolatedModule();

      mockLimitFn.mockResolvedValue({
        success: true,
        remaining: -30,
        reset: Date.now() + 3600000,
        limit: 250000,
      });

      await deductUsage(
        "user-123",
        "pro",
        1000,
        1000,
        1000,
        { enabled: true, hasBalance: true, autoReloadEnabled: false },
        undefined,
        undefined,
        0,
        undefined,
        undefined,
        undefined,
        "settlement-123",
      );

      expect(mockDeductFromBalance).toHaveBeenCalledWith(
        "user-123",
        42,
        "settlement-123",
      );
    });

    it("should skip deduction for free tier", async () => {
      const { deductUsage } = getIsolatedModule();

      await deductUsage("user-123", "free", 1000, 1000, 500);

      expect(mockLimitFn).not.toHaveBeenCalled();
    });

    it("should refund when provider cost is less than estimated (over-estimation)", async () => {
      const { deductUsage, calculateTokenCost, billableCostDollarsToPoints } =
        getIsolatedModule();

      // Estimate: 10000 input tokens = 70 billable points
      const estimatedInputTokens = 10000;
      const estimatedCost = calculateTokenCost(estimatedInputTokens, "input");

      // Actual provider cost: $0.002 = 28 billable points
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

      // Should refund the difference (70 - 28 = 42 points)
      const expectedRefund =
        estimatedCost - billableCostDollarsToPoints(providerCostDollars);
      expect(mockHincrbyFn).toHaveBeenCalledWith(
        expect.stringContaining("usage:monthly"),
        "tokens",
        expectedRefund,
      );
      // Should NOT call limiter to deduct more
      expect(mockLimitFn).not.toHaveBeenCalled();
    });

    it("should refund mixed over-estimation from extra usage before included usage", async () => {
      const { deductUsage, calculateTokenCost } = getIsolatedModule();
      const estimatedInputTokens = 7600;
      const estimatedCost = calculateTokenCost(estimatedInputTokens, "input");
      const providerCostDollars = 0.003;

      expect(estimatedCost).toBe(54);

      const result = await deductUsage(
        "user-123",
        "pro",
        estimatedInputTokens,
        5000,
        500,
        undefined,
        providerCostDollars,
        undefined,
        0,
        undefined,
        {
          pointsDeducted: 17,
          extraUsagePointsDeducted: 37,
        },
      );

      expect(mockRefundToBalance).toHaveBeenCalledWith("user-123", 12);
      expect(mockHincrbyFn).not.toHaveBeenCalled();
      expect(result).toEqual({
        includedPointsDeducted: 17,
        extraUsagePointsDeducted: 25,
        uncoveredPoints: 0,
        usageDeductionFailed: false,
      });
    });

    it("should preserve the initial deduction split when final deduction fails", async () => {
      const { deductUsage } = getIsolatedModule();
      const consoleSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});
      mockLimitFn.mockResolvedValueOnce({
        success: true,
        remaining: 10,
        reset: Date.now() + 3600000,
        limit: 250000,
      });
      mockLimitFn.mockRejectedValueOnce(new Error("upstash unavailable"));

      const result = await deductUsage(
        "user-123",
        "pro",
        7600,
        5000,
        500,
        undefined,
        0.006,
        undefined,
        0,
        undefined,
        {
          pointsDeducted: 17,
          extraUsagePointsDeducted: 37,
        },
      );

      expect(result).toEqual({
        includedPointsDeducted: 17,
        extraUsagePointsDeducted: 37,
        uncoveredPoints: 30,
        usageDeductionFailed: true,
        usageDeductionFailureReason: "deduction_failed",
      });
      consoleSpy.mockRestore();
    });

    it("should refund when token-based actual cost is less than estimated", async () => {
      const { deductUsage, calculateTokenCost } = getIsolatedModule();

      // Estimate: 10000 input tokens = 70 billable points (pre-deducted)
      const estimatedInputTokens = 10000;
      const estimatedCost = calculateTokenCost(estimatedInputTokens, "input");

      // Actual: 2000 input + 500 output = 14 + 21 = 35 billable points
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

      // Should refund the difference (70 - 35 = 35 points)
      const expectedRefund = estimatedCost - actualCost;
      expect(mockHincrbyFn).toHaveBeenCalledWith(
        expect.stringContaining("usage:monthly"),
        "tokens",
        expectedRefund,
      );
    });

    it("should not refund or charge when actual cost equals estimated", async () => {
      const { deductUsage } = getIsolatedModule();

      // Estimate: 10000 input tokens = 70 billable points
      const estimatedInputTokens = 10000;

      // Actual provider cost exactly matches after applying the billable multiplier.
      const providerCostDollars = 0.005;

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
      const { deductUsage } = getIsolatedModule();

      // Estimate: 1000 input tokens = 7 billable points (pre-deducted)
      const estimatedInputTokens = 1000;

      // Actual provider cost: $0.005 = 70 billable points (much more than 7)
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

    it("should use served fallback model pricing for actual token cost when provider cost is absent", async () => {
      const { deductUsage, calculateTokenCost } = getIsolatedModule();

      const estimatedInputTokens = 1_000_000;
      const actualInputTokens = 1_000_000;
      const actualOutputTokens = 1_000_000;
      const selectedModel = "agent-model-free";
      const servedModel = "model-kimi-k2.7-code";
      const initialDeduction = calculateTokenCost(
        estimatedInputTokens,
        "input",
        selectedModel,
      );
      const expectedActualCost =
        calculateTokenCost(actualInputTokens, "input", servedModel) +
        calculateTokenCost(actualOutputTokens, "output", servedModel);
      const expectedAdditional = expectedActualCost - initialDeduction;

      mockLimitFn
        .mockResolvedValueOnce({
          success: true,
          remaining: 100_000,
          reset: Date.now() + 3600000,
          limit: 250000,
        })
        .mockResolvedValueOnce({
          success: true,
          remaining: 100_000 - expectedAdditional,
          reset: Date.now() + 3600000,
          limit: 250000,
        });

      const result = await deductUsage(
        "user-123",
        "pro",
        estimatedInputTokens,
        actualInputTokens,
        actualOutputTokens,
        undefined,
        undefined,
        selectedModel,
        0,
        undefined,
        { pointsDeducted: initialDeduction },
        servedModel,
      );

      expect(expectedAdditional).toBe(68_040);
      expect(mockLimitFn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ rate: expectedAdditional }),
      );
      expect(result).toEqual({
        includedPointsDeducted: expectedActualCost,
        extraUsagePointsDeducted: 0,
        uncoveredPoints: 0,
        usageDeductionFailed: false,
      });
    });

    it("should prefer raw provider cost over served fallback token pricing", async () => {
      const { deductUsage, calculateTokenCost, billableCostDollarsToPoints } =
        getIsolatedModule();

      const estimatedInputTokens = 1_000_000;
      const selectedModel = "agent-model-free";
      const servedModel = "model-kimi-k2.7-code";
      const providerCostDollars = 0.42;
      const initialDeduction = calculateTokenCost(
        estimatedInputTokens,
        "input",
        selectedModel,
      );
      const expectedProviderCost =
        billableCostDollarsToPoints(providerCostDollars);
      const expectedAdditional = expectedProviderCost - initialDeduction;

      mockLimitFn
        .mockResolvedValueOnce({
          success: true,
          remaining: 100_000,
          reset: Date.now() + 3600000,
          limit: 250000,
        })
        .mockResolvedValueOnce({
          success: true,
          remaining: 100_000 - expectedAdditional,
          reset: Date.now() + 3600000,
          limit: 250000,
        });

      const result = await deductUsage(
        "user-123",
        "pro",
        estimatedInputTokens,
        1_000_000,
        1_000_000,
        undefined,
        providerCostDollars,
        selectedModel,
        0,
        undefined,
        { pointsDeducted: initialDeduction },
        servedModel,
      );

      expect(expectedAdditional).toBe(4_620);
      expect(mockLimitFn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ rate: expectedAdditional }),
      );
      expect(result).toEqual({
        includedPointsDeducted: expectedProviderCost,
        extraUsagePointsDeducted: 0,
        uncoveredPoints: 0,
        usageDeductionFailed: false,
      });
    });
  });

  describe("refundUsage", () => {
    it("should refund bucket tokens via Redis hincrby", async () => {
      const { refundUsage } = getIsolatedModule();

      await refundUsage("user-123", "pro", 1000, 0);

      expect(mockHincrbyFn).toHaveBeenCalledWith(
        expect.stringContaining("usage:monthly"),
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
      const { monthly: monthlyLimit } = getBudgetLimits("pro");

      mockHincrbyFn.mockResolvedValue(monthlyLimit + 10000);

      await refundUsage("user-123", "pro", 50000, 0);

      expect(mockHsetFn).toHaveBeenCalled();
    });

    it("caps refunds at the stored cycle allocation", async () => {
      const { refundUsage } = getIsolatedModule();
      mockHgetFn.mockResolvedValue(200_000);
      mockHincrbyFn.mockResolvedValue(210_000);

      await refundUsage("user-123", "pro", 50_000, 0);

      expect(mockHsetFn).toHaveBeenCalledWith("usage:monthly:user-123:pro", {
        tokens: 200_000,
      });
    });
  });

  describe("resetRateLimitBuckets", () => {
    it("atomically replaces the monthly bucket with an explicit TTL", async () => {
      const { resetRateLimitBuckets } = getIsolatedModule();

      await resetRateLimitBuckets("user-123", "pro");

      expect(mockEvalFn).toHaveBeenCalledWith(
        expect.stringContaining('redis.call("EXPIRE", bucketKey'),
        ["usage:monthly:user-123:pro"],
        [
          250_000,
          250_000,
          250_000,
          expect.any(Number),
          expect.any(Number),
          30 * 24 * 60 * 60,
        ],
      );
    });

    it("aligns monthly reset metadata to the Stripe period end", async () => {
      const nowSeconds = 1_700_000_000;
      const periodEndSeconds = nowSeconds + 31 * 24 * 60 * 60;
      const nowSpy = jest.spyOn(Date, "now").mockReturnValue(nowSeconds * 1000);

      try {
        const { resetRateLimitBuckets } = getIsolatedModule();

        await resetRateLimitBuckets("user-123", "pro", periodEndSeconds);

        expect(mockEvalFn).toHaveBeenCalledWith(
          expect.any(String),
          ["usage:monthly:user-123:pro"],
          [
            250_000,
            250_000,
            250_000,
            nowSeconds * 1000,
            (periodEndSeconds - 30 * 24 * 60 * 60) * 1000,
            32 * 24 * 60 * 60,
          ],
        );
      } finally {
        nowSpy.mockRestore();
      }
    });

    it("initializes a price-specific cycle allocation", async () => {
      const { resetRateLimitBuckets } = getIsolatedModule();

      await resetRateLimitBuckets("user-123", "pro", undefined, 200_000);

      expect(mockEvalFn).toHaveBeenCalledWith(
        expect.any(String),
        ["usage:monthly:user-123:pro"],
        [
          200_000,
          200_000,
          250_000,
          expect.any(Number),
          expect.any(Number),
          30 * 24 * 60 * 60,
        ],
      );
    });

    it("does not backdate reset metadata for a stale Stripe period end", async () => {
      const nowSeconds = 1_700_000_000;
      const stalePeriodEndSeconds = nowSeconds - 60;
      const nowSpy = jest.spyOn(Date, "now").mockReturnValue(nowSeconds * 1000);

      try {
        const { resetRateLimitBuckets } = getIsolatedModule();

        await resetRateLimitBuckets("user-123", "pro", stalePeriodEndSeconds);

        expect(mockEvalFn).toHaveBeenCalledWith(
          expect.any(String),
          ["usage:monthly:user-123:pro"],
          [
            250_000,
            250_000,
            250_000,
            nowSeconds * 1000,
            nowSeconds * 1000,
            30 * 24 * 60 * 60,
          ],
        );
      } finally {
        nowSpy.mockRestore();
      }
    });

    it("should not throw when the atomic Redis write fails", async () => {
      const { resetRateLimitBuckets } = getIsolatedModule();

      mockEvalFn.mockRejectedValue(new Error("Redis down"));
      const consoleSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});

      await expect(
        resetRateLimitBuckets("user-123", "pro"),
      ).resolves.toBeUndefined();

      consoleSpy.mockRestore();
    });
  });

  describe("capCurrentCycleAllocation", () => {
    it("initializes a missing bucket at the requested allocation", async () => {
      const { capCurrentCycleAllocation } = getIsolatedModule();
      mockExistsFn.mockResolvedValue(0);
      mockHgetFn.mockResolvedValue(200_000);

      const result = await capCurrentCycleAllocation(
        "user-123",
        "pro",
        200_000,
      );

      expect(result).toEqual({
        created: true,
        previousAllocation: 250_000,
        previousRemaining: 250_000,
        targetAllocation: 200_000,
        targetRemaining: 200_000,
        pointsRemoved: 0,
      });
      expect(mockEvalFn).toHaveBeenCalledWith(
        expect.stringContaining('"HSET"'),
        ["usage:monthly:user-123:pro"],
        expect.arrayContaining([200_000, 200_000, 250_000]),
      );
    });

    it("lowers the current cycle without restoring consumed usage", async () => {
      const { capCurrentCycleAllocation } = getIsolatedModule();
      mockEvalFn.mockResolvedValue([
        250_000, 150_000, 200_000, 100_000, 50_000,
      ]);

      const result = await capCurrentCycleAllocation(
        "user-123",
        "pro",
        200_000,
      );

      expect(mockLimitFn).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        created: false,
        previousAllocation: 250_000,
        previousRemaining: 150_000,
        targetAllocation: 200_000,
        targetRemaining: 100_000,
        pointsRemoved: 50_000,
      });
      expect(mockEvalFn).toHaveBeenCalledWith(
        expect.any(String),
        ["usage:monthly:user-123:pro"],
        [200_000, 250_000, -1],
      );
    });

    it("does not increase an already-lower prorated allocation", async () => {
      const { capCurrentCycleAllocation } = getIsolatedModule();
      mockEvalFn.mockResolvedValue([150_000, 100_000, 150_000, 100_000, 0]);

      const result = await capCurrentCycleAllocation(
        "user-123",
        "pro",
        200_000,
      );

      expect(result.targetAllocation).toBe(150_000);
      expect(result.targetRemaining).toBe(100_000);
      expect(result.pointsRemoved).toBe(0);
    });
  });

  describe("deductUsage - split deduction (peek-then-deduct)", () => {
    it("should deduct overflow from extra usage when bucket has insufficient balance", async () => {
      const { deductUsage } = getIsolatedModule();

      // Peek: bucket has 10 remaining
      mockLimitFn.mockResolvedValueOnce({
        success: true,
        remaining: 10,
        reset: Date.now() + 3600000,
        limit: 250000,
      });
      // Deduct fromBucket (10) from bucket
      mockLimitFn.mockResolvedValueOnce({
        success: true,
        remaining: 0,
        reset: Date.now() + 3600000,
        limit: 250000,
      });

      // Estimated 1000 input = 7 points, actual provider cost = $0.005 = 70 billable points.
      // Difference = 70 - 7 = 63 additional needed.
      // Bucket has 10, so fromBucket=10, fromExtraUsage=53.
      const result = await deductUsage(
        "user-123",
        "pro",
        1000,
        5000,
        1000,
        { enabled: true, hasBalance: true, autoReloadEnabled: false },
        0.005,
      );

      // Should peek first (rate: 0), then deduct only what bucket can cover (rate: 10)
      expect(mockLimitFn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ rate: 0 }),
      );
      expect(mockLimitFn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ rate: 10 }),
      );
      // Should deduct the overflow (53) from extra usage
      expect(mockDeductFromBalance).toHaveBeenCalledWith(
        "user-123",
        53,
        undefined,
      );
      expect(result).toEqual({
        includedPointsDeducted: 17,
        extraUsagePointsDeducted: 53,
        uncoveredPoints: 0,
        usageDeductionFailed: false,
      });
    });

    it("reports uncovered points when overflow extra usage deduction fails", async () => {
      const { deductUsage } = getIsolatedModule();

      mockLimitFn.mockResolvedValueOnce({
        success: true,
        remaining: 10,
        reset: Date.now() + 3600000,
        limit: 250000,
      });
      mockLimitFn.mockResolvedValueOnce({
        success: true,
        remaining: 0,
        reset: Date.now() + 3600000,
        limit: 250000,
      });
      mockDeductFromBalance.mockResolvedValueOnce({
        success: false,
        newBalanceDollars: 0,
        insufficientFunds: true,
        monthlyCapExceeded: false,
      });

      const result = await deductUsage(
        "user-123",
        "pro",
        1000,
        5000,
        1000,
        { enabled: true, hasBalance: true, autoReloadEnabled: false },
        0.005,
      );

      expect(mockDeductFromBalance).toHaveBeenCalledWith(
        "user-123",
        53,
        undefined,
      );
      expect(result).toEqual({
        includedPointsDeducted: 17,
        extraUsagePointsDeducted: 0,
        uncoveredPoints: 53,
        usageDeductionFailed: true,
        usageDeductionFailureReason: "insufficient_funds",
      });
    });

    it("reports monthly cap failures when overflow extra usage deduction fails", async () => {
      const { deductUsage } = getIsolatedModule();

      mockLimitFn
        .mockResolvedValueOnce({
          success: true,
          remaining: 10,
          reset: Date.now() + 3600000,
          limit: 250000,
        })
        .mockResolvedValueOnce({
          success: true,
          remaining: 0,
          reset: Date.now() + 3600000,
          limit: 250000,
        });
      mockDeductFromBalance.mockResolvedValueOnce({
        success: false,
        newBalanceDollars: 20,
        insufficientFunds: true,
        monthlyCapExceeded: true,
      });

      const result = await deductUsage(
        "user-123",
        "pro",
        1000,
        5000,
        1000,
        { enabled: true, hasBalance: true, autoReloadEnabled: false },
        0.005,
      );

      expect(result).toEqual({
        includedPointsDeducted: 17,
        extraUsagePointsDeducted: 0,
        uncoveredPoints: 53,
        usageDeductionFailed: true,
        usageDeductionFailureReason: "monthly_cap_exceeded",
      });
    });

    it("reports auto-reload failures when overflow extra usage deduction fails", async () => {
      const { deductUsage } = getIsolatedModule();

      mockLimitFn
        .mockResolvedValueOnce({
          success: true,
          remaining: 10,
          reset: Date.now() + 3600000,
          limit: 250000,
        })
        .mockResolvedValueOnce({
          success: true,
          remaining: 0,
          reset: Date.now() + 3600000,
          limit: 250000,
        });
      mockDeductFromBalance.mockResolvedValueOnce({
        success: false,
        newBalanceDollars: 0,
        insufficientFunds: true,
        monthlyCapExceeded: false,
        autoReloadTriggered: true,
        autoReloadResult: { success: false, reason: "payment_failed" },
      });

      const result = await deductUsage(
        "user-123",
        "pro",
        1000,
        5000,
        1000,
        { enabled: true, hasBalance: false, autoReloadEnabled: true },
        0.005,
      );

      expect(result).toEqual({
        includedPointsDeducted: 17,
        extraUsagePointsDeducted: 0,
        uncoveredPoints: 53,
        usageDeductionFailed: true,
        usageDeductionFailureReason: "auto_reload_failed",
      });
    });

    it("reports team member cap failures when team overflow deduction fails", async () => {
      const { deductUsage } = getIsolatedModule();

      mockLimitFn
        .mockResolvedValueOnce({
          success: true,
          remaining: 10,
          reset: Date.now() + 3600000,
          limit: 250000,
        })
        .mockResolvedValueOnce({
          success: true,
          remaining: 0,
          reset: Date.now() + 3600000,
          limit: 250000,
        });
      mockDeductFromTeamBalance.mockResolvedValueOnce({
        success: false,
        newBalanceDollars: 20,
        insufficientFunds: true,
        monthlyCapExceeded: false,
        memberCapExceeded: true,
        memberDisabled: false,
        poolDisabled: false,
      });

      const result = await deductUsage(
        "user-123",
        "team",
        1000,
        5000,
        1000,
        { enabled: true, hasBalance: true, autoReloadEnabled: false },
        0.005,
        undefined,
        0,
        "org-123",
      );

      expect(mockDeductFromTeamBalance).toHaveBeenCalledWith(
        "org-123",
        "user-123",
        53,
        undefined,
      );
      expect(result).toEqual({
        includedPointsDeducted: 17,
        extraUsagePointsDeducted: 0,
        uncoveredPoints: 53,
        usageDeductionFailed: true,
        usageDeductionFailureReason: "member_cap_exceeded",
      });
    });

    it("should not call extra usage when bucket covers the full amount", async () => {
      const { deductUsage } = getIsolatedModule();

      // Peek: bucket has plenty remaining
      mockLimitFn.mockResolvedValueOnce({
        success: true,
        remaining: 100,
        reset: Date.now() + 3600000,
        limit: 250000,
      });
      // Deduct full additional cost (45) from bucket
      mockLimitFn.mockResolvedValueOnce({
        success: true,
        remaining: 55,
        reset: Date.now() + 3600000,
        limit: 250000,
      });

      await deductUsage(
        "user-123",
        "pro",
        1000,
        5000,
        1000,
        { enabled: true, hasBalance: true, autoReloadEnabled: false },
        0.005,
      );

      expect(mockDeductFromBalance).not.toHaveBeenCalled();
    });
  });

  describe("deductUsageDelta", () => {
    it("deducts a mid-run delta from included bucket first and extra usage second", async () => {
      const { deductUsageDelta } = getIsolatedModule();

      mockLimitFn
        .mockResolvedValueOnce({
          success: true,
          remaining: 10,
          reset: Date.now() + 3600000,
          limit: 250000,
        })
        .mockResolvedValueOnce({
          success: true,
          remaining: 0,
          reset: Date.now() + 3600000,
          limit: 250000,
        });

      const result = await deductUsageDelta("user-123", "pro", 43, {
        enabled: true,
        hasBalance: true,
        autoReloadEnabled: false,
      });

      expect(mockLimitFn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ rate: 0 }),
      );
      expect(mockLimitFn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ rate: 10 }),
      );
      expect(mockDeductFromBalance).toHaveBeenCalledWith(
        "user-123",
        33,
        undefined,
      );
      expect(result).toEqual({
        includedPointsDeducted: 10,
        extraUsagePointsDeducted: 33,
        uncoveredPoints: 0,
        usageDeductionFailed: false,
      });
    });

    it("forwards a settlement ID to the mid-run extra usage deduction", async () => {
      const { deductUsageDelta } = getIsolatedModule();

      mockLimitFn
        .mockResolvedValueOnce({
          success: true,
          remaining: 10,
          reset: Date.now() + 3600000,
          limit: 250000,
        })
        .mockResolvedValueOnce({
          success: true,
          remaining: 0,
          reset: Date.now() + 3600000,
          limit: 250000,
        });

      await deductUsageDelta(
        "user-123",
        "pro",
        43,
        { enabled: true, hasBalance: true, autoReloadEnabled: false },
        undefined,
        "settlement-123",
      );

      expect(mockDeductFromBalance).toHaveBeenCalledWith(
        "user-123",
        33,
        "settlement-123",
      );
    });

    it("reports uncovered mid-run delta when extra usage cannot cover overflow", async () => {
      const { deductUsageDelta } = getIsolatedModule();

      mockLimitFn
        .mockResolvedValueOnce({
          success: true,
          remaining: 10,
          reset: Date.now() + 3600000,
          limit: 250000,
        })
        .mockResolvedValueOnce({
          success: true,
          remaining: 0,
          reset: Date.now() + 3600000,
          limit: 250000,
        });
      mockDeductFromBalance.mockResolvedValueOnce({
        success: false,
        newBalanceDollars: 0,
        insufficientFunds: true,
        monthlyCapExceeded: false,
      });

      const result = await deductUsageDelta("user-123", "pro", 43, {
        enabled: true,
        hasBalance: true,
        autoReloadEnabled: false,
      });

      expect(result).toEqual({
        includedPointsDeducted: 10,
        extraUsagePointsDeducted: 0,
        uncoveredPoints: 33,
        usageDeductionFailed: true,
        usageDeductionFailureReason: "insufficient_funds",
      });
    });

    it("falls back to extra usage when included bucket debit fails after peek", async () => {
      const { deductUsageDelta } = getIsolatedModule();

      mockLimitFn
        .mockResolvedValueOnce({
          success: true,
          remaining: 10,
          reset: Date.now() + 3600000,
          limit: 250000,
        })
        .mockResolvedValueOnce({
          success: false,
          remaining: 0,
          reset: Date.now() + 3600000,
          limit: 250000,
        });

      const result = await deductUsageDelta("user-123", "pro", 43, {
        enabled: true,
        hasBalance: true,
        autoReloadEnabled: false,
      });

      expect(mockDeductFromBalance).toHaveBeenCalledWith(
        "user-123",
        43,
        undefined,
      );
      expect(result).toEqual({
        includedPointsDeducted: 0,
        extraUsagePointsDeducted: 43,
        uncoveredPoints: 0,
        usageDeductionFailed: false,
      });
    });

    it("preserves included mid-run deduction when extra usage charge throws", async () => {
      const consoleErrorSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      try {
        const { deductUsageDelta } = getIsolatedModule();

        mockLimitFn
          .mockResolvedValueOnce({
            success: true,
            remaining: 10,
            reset: Date.now() + 3600000,
            limit: 250000,
          })
          .mockResolvedValueOnce({
            success: true,
            remaining: 0,
            reset: Date.now() + 3600000,
            limit: 250000,
          });
        mockDeductFromBalance.mockRejectedValueOnce(new Error("stripe down"));

        const result = await deductUsageDelta("user-123", "pro", 43, {
          enabled: true,
          hasBalance: true,
          autoReloadEnabled: false,
        });

        expect(result).toEqual({
          includedPointsDeducted: 10,
          extraUsagePointsDeducted: 0,
          uncoveredPoints: 33,
          usageDeductionFailed: true,
          usageDeductionFailureReason: "deduction_failed",
        });
      } finally {
        consoleErrorSpy.mockRestore();
      }
    });

    it("does not re-charge mid-run deductions during final reconciliation", async () => {
      const { deductUsage } = getIsolatedModule();

      const result = await deductUsage(
        "user-123",
        "pro",
        1000,
        5000,
        1000,
        { enabled: true, hasBalance: true, autoReloadEnabled: false },
        0.005,
        undefined,
        0,
        undefined,
        { pointsDeducted: 35, extraUsagePointsDeducted: 35 },
      );

      expect(mockLimitFn).not.toHaveBeenCalled();
      expect(mockDeductFromBalance).not.toHaveBeenCalled();
      expect(result).toEqual({
        includedPointsDeducted: 35,
        extraUsagePointsDeducted: 35,
        uncoveredPoints: 0,
        usageDeductionFailed: false,
      });
    });
  });

  describe("concurrent deduction safety", () => {
    it("should reject a concurrent check when its final deduction fails", async () => {
      const { checkTokenBucketLimit } = getIsolatedModule();

      // Simulate two concurrent requests seeing the same bucket state
      let deductionCalls = 0;
      let callCount = 0;
      mockLimitFn.mockImplementation(
        async (_key: string, opts: { rate: number }) => {
          callCount++;
          // Peek calls (rate: 0) return enough remaining for one request.
          if (opts.rate === 0) {
            return {
              success: true,
              remaining: 7,
              reset: Date.now() + 3600000,
              limit: 250000,
            };
          }

          deductionCalls++;
          if (deductionCalls === 1) {
            return {
              success: true,
              remaining: 0,
              reset: Date.now() + 3600000,
              limit: 250000,
            };
          }

          return {
            success: false,
            remaining: 0,
            reset: Date.now() + 3600000,
            limit: 250000,
          };
        },
      );

      // Run two concurrent checks
      const results = await Promise.allSettled([
        checkTokenBucketLimit("user-123", "pro", 1000),
        checkTokenBucketLimit("user-123", "pro", 1000),
      ]);

      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
      // Limiter was called for both requests (peek + deduct each)
      expect(callCount).toBeGreaterThanOrEqual(4);
    });
  });

  describe("provider cost vs token cost paths", () => {
    it("should produce different deductions when provider cost differs from token calculation", async () => {
      const { deductUsage, calculateTokenCost, billableCostDollarsToPoints } =
        getIsolatedModule();

      const estimatedInput = 10000;

      // Path 1: token-based (actual = 10000 input + 1000 output)
      const tokenActualCost =
        calculateTokenCost(10000, "input") + calculateTokenCost(1000, "output");

      // Path 2: provider cost ($0.01 = 130 billable points)
      const providerCost = 0.01;
      const providerCostPoints = billableCostDollarsToPoints(providerCost);

      // These should differ
      expect(tokenActualCost).not.toBe(providerCostPoints);

      // Both paths should execute without error
      await deductUsage("user-123", "pro", estimatedInput, 10000, 1000);
      mockLimitFn.mockClear();
      mockHincrbyFn.mockClear();

      await deductUsage(
        "user-123",
        "pro",
        estimatedInput,
        10000,
        1000,
        undefined,
        providerCost,
      );
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
