import { describe, it, expect } from "@jest/globals";

import {
  billableCostDollarsToPoints,
  calculateRawModelUsageCostDollars,
  calculateTokenCost,
  calculateRawTokenCost,
  calculateTierChangeCredits,
  getBudgetLimits,
  getCycleExpireSeconds,
  getSubscriptionPrice,
  isUserRateLimitKey,
  POINTS_PER_DOLLAR,
} from "../token-bucket";

/**
 * Unit tests for token-bucket rate limiting pure functions.
 *
 * Note: The async functions (checkTokenBucketLimit, deductUsage, refundUsage)
 * are difficult to unit test in isolation due to the singleton Redis client pattern
 * and Jest module caching. These functions are better suited for integration tests
 * that can properly initialize and control the Redis/Ratelimit dependencies.
 */
describe("token-bucket", () => {
  // ==========================================================================
  // calculateTokenCost - Core pricing logic
  // ==========================================================================
  describe("calculateTokenCost", () => {
    it("should return 0 for zero or negative tokens", () => {
      expect(calculateTokenCost(0, "input")).toBe(0);
      expect(calculateTokenCost(0, "output")).toBe(0);
      expect(calculateTokenCost(-100, "input")).toBe(0);
      expect(calculateTokenCost(-100, "output")).toBe(0);
    });

    it("should calculate input token cost correctly ($0.50/1M tokens * 1.3x)", () => {
      // 1M input tokens = $0.50 * 1.3 = 6500 points
      expect(calculateTokenCost(1_000_000, "input")).toBe(6500);
      // 1K input tokens = ceil(0.001 * 0.5 * 10000 * 1.3) = 7 points
      expect(calculateTokenCost(1000, "input")).toBe(7);
      // 10M input tokens = $5.00 * 1.3 = 65000 points
      expect(calculateTokenCost(10_000_000, "input")).toBe(65000);
    });

    it("should calculate output token cost correctly ($3.00/1M tokens * 1.3x)", () => {
      // 1M output tokens = $3.00 * 1.3 = 39000 points
      expect(calculateTokenCost(1_000_000, "output")).toBe(39000);
      // 1K output tokens = ceil(0.001 * 3.0 * 10000 * 1.3) = 39 points
      expect(calculateTokenCost(1000, "output")).toBe(39);
      // 10M output tokens = $30.00 * 1.3 = 390000 points
      expect(calculateTokenCost(10_000_000, "output")).toBe(390000);
    });

    it("should round up small amounts to at least 1 point", () => {
      expect(calculateTokenCost(1, "input")).toBe(1);
      expect(calculateTokenCost(1, "output")).toBe(1);
      expect(calculateTokenCost(100, "input")).toBe(1);
    });

    it("output should cost 6x input (ratio of $3.00/$0.50)", () => {
      const inputCost = calculateTokenCost(1_000_000, "input");
      const outputCost = calculateTokenCost(1_000_000, "output");
      expect(outputCost / inputCost).toBe(6);
    });

    it("should use Math.ceil to always round up", () => {
      // 10 tokens at $0.50/1M * 1.3 = fractional point → rounds up to 1
      expect(calculateTokenCost(10, "input")).toBe(1);
      // 10000 tokens at $0.50/1M * 1.3 = 65 points
      expect(calculateTokenCost(10000, "input")).toBe(65);
    });
  });

  // ==========================================================================
  // calculateRawTokenCost - Analytics/reporting cost without usage multiplier
  // ==========================================================================
  describe("calculateRawTokenCost", () => {
    it("should return 0 for zero or negative tokens", () => {
      expect(calculateRawTokenCost(0, "input")).toBe(0);
      expect(calculateRawTokenCost(0, "output")).toBe(0);
      expect(calculateRawTokenCost(-100, "input")).toBe(0);
      expect(calculateRawTokenCost(-100, "output")).toBe(0);
    });

    it("should calculate raw input token cost without the 1.3x multiplier", () => {
      expect(calculateRawTokenCost(1_000_000, "input")).toBe(5000);
      expect(calculateRawTokenCost(1000, "input")).toBe(5);
    });

    it("should calculate raw output token cost without the 1.3x multiplier", () => {
      expect(calculateRawTokenCost(1_000_000, "output")).toBe(30000);
      expect(calculateRawTokenCost(1000, "output")).toBe(30);
    });
  });

  describe("calculateRawModelUsageCostDollars", () => {
    it("prices cached and uncached input at the served model's rates", () => {
      expect(
        calculateRawModelUsageCostDollars({
          inputTokens: 1_000_000,
          outputTokens: 100_000,
          cacheReadTokens: 800_000,
          modelName: "x-ai/grok-4.5",
        }),
      ).toBeCloseTo(1.4);
    });

    it("prices Kimi K3 cached input at OpenRouter's $0.30/M rate", () => {
      expect(
        calculateRawModelUsageCostDollars({
          inputTokens: 1_000_000,
          outputTokens: 100_000,
          cacheReadTokens: 800_000,
          modelName: "moonshotai/kimi-k3-20260715",
        }),
      ).toBeCloseTo(2.34);
    });

    it("prices DeepSeek V4 Flash 0731 cached input at OpenRouter's $0.0028/M rate", () => {
      expect(
        calculateRawModelUsageCostDollars({
          inputTokens: 1_000_000,
          outputTokens: 100_000,
          cacheReadTokens: 800_000,
          cacheWriteTokens: 100_000,
          modelName: "deepseek/deepseek-v4-flash-20260731",
        }),
      ).toBeCloseTo(0.05824, 5);
    });

    it("prices the previous canonical DeepSeek V4 Flash response ID", () => {
      expect(
        calculateRawModelUsageCostDollars({
          inputTokens: 1_000_000,
          outputTokens: 100_000,
          cacheReadTokens: 800_000,
          cacheWriteTokens: 100_000,
          modelName: "deepseek/deepseek-v4-flash-20260423",
        }),
      ).toBeCloseTo(0.0504, 5);
    });

    it("recognizes dated Anthropic response model IDs", () => {
      expect(
        calculateRawModelUsageCostDollars({
          inputTokens: 200,
          outputTokens: 40,
          cacheReadTokens: 20,
          cacheWriteTokens: 10,
          modelName: "anthropic/claude-4.6-opus-20260205",
        }),
      ).toBeCloseTo(0.0019225);
    });

    it("clamps invalid and overlapping cache token counts", () => {
      expect(
        calculateRawModelUsageCostDollars({
          inputTokens: 100,
          outputTokens: Number.NaN,
          cacheReadTokens: 80,
          cacheWriteTokens: 80,
          modelName: "model-deepseek-v4-pro",
        }),
      ).toBeCloseTo(0.00000899);
      expect(
        calculateRawModelUsageCostDollars({
          inputTokens: Number.POSITIVE_INFINITY,
          outputTokens: Number.NEGATIVE_INFINITY,
          cacheReadTokens: Number.NaN,
        }),
      ).toBe(0);
    });
  });

  // ==========================================================================
  // getBudgetLimits - Subscription tier limits (monthly credit pool)
  // ==========================================================================
  describe("getBudgetLimits", () => {
    it("should return 0 limit for free tier", () => {
      const limits = getBudgetLimits("free");
      expect(limits.monthly).toBe(0);
    });

    it("should return fixed monthly credits for pro tier ($25)", () => {
      const limits = getBudgetLimits("pro");
      expect(limits.monthly).toBe(250_000);
    });

    it("should return fixed monthly credits for pro-plus tier ($60)", () => {
      const limits = getBudgetLimits("pro-plus");
      expect(limits.monthly).toBe(600_000);
    });

    it("should return fixed monthly credits for ultra tier ($200)", () => {
      const limits = getBudgetLimits("ultra");
      expect(limits.monthly).toBe(2_000_000);
    });

    it("should return fixed monthly credits for team tier ($40)", () => {
      const limits = getBudgetLimits("team");
      expect(limits.monthly).toBe(400_000);
    });

    it("ultra should have 8x more monthly credits than pro", () => {
      const proLimits = getBudgetLimits("pro");
      const ultraLimits = getBudgetLimits("ultra");

      expect(ultraLimits.monthly / proLimits.monthly).toBe(8);
    });

    it("pro-plus should have 2.4x more monthly credits than pro", () => {
      const proLimits = getBudgetLimits("pro");
      const proPlusLimits = getBudgetLimits("pro-plus");

      expect(proPlusLimits.monthly / proLimits.monthly).toBe(2.4);
    });

    it("team should have 1.6x more monthly credits than pro", () => {
      const proLimits = getBudgetLimits("pro");
      const teamLimits = getBudgetLimits("team");

      expect(teamLimits.monthly / proLimits.monthly).toBe(1.6);
    });

    it("should return 0 for unknown subscription tier", () => {
      const limits = getBudgetLimits("nonexistent" as any);
      expect(limits.monthly).toBe(0);
    });
  });

  // ==========================================================================
  // getSubscriptionPrice - Dollar amount from credits
  // ==========================================================================
  describe("getSubscriptionPrice", () => {
    it("should return 0 for free tier", () => {
      expect(getSubscriptionPrice("free")).toBe(0);
    });

    it("should return subscription price in dollars for each tier", () => {
      expect(getSubscriptionPrice("pro")).toBe(25);
      expect(getSubscriptionPrice("pro-plus")).toBe(60);
      expect(getSubscriptionPrice("ultra")).toBe(200);
      expect(getSubscriptionPrice("team")).toBe(40);
    });

    it("should return 0 for unknown tier", () => {
      expect(getSubscriptionPrice("nonexistent" as any)).toBe(0);
    });

    it("should be consistent with getBudgetLimits", () => {
      for (const tier of [
        "free",
        "pro",
        "pro-plus",
        "ultra",
        "team",
      ] as const) {
        const dollars = getSubscriptionPrice(tier);
        const points = getBudgetLimits(tier).monthly;
        expect(dollars).toBe(points / POINTS_PER_DOLLAR);
      }
    });
  });

  // ==========================================================================
  // POINTS_PER_DOLLAR constant
  // ==========================================================================
  describe("POINTS_PER_DOLLAR", () => {
    it("should be 10000 (1 point = $0.0001)", () => {
      expect(POINTS_PER_DOLLAR).toBe(10_000);
    });
  });

  describe("billableCostDollarsToPoints", () => {
    it("applies the normal usage multiplier to raw provider and tool cost", () => {
      expect(billableCostDollarsToPoints(1)).toBe(13_000);
      expect(billableCostDollarsToPoints(0.005)).toBe(65);
      expect(billableCostDollarsToPoints(0.000000000001)).toBe(1);
    });

    it("returns 0 for non-positive or invalid cost", () => {
      expect(billableCostDollarsToPoints(0)).toBe(0);
      expect(billableCostDollarsToPoints(-1)).toBe(0);
      expect(billableCostDollarsToPoints(Number.NaN)).toBe(0);
    });
  });

  describe("getCycleExpireSeconds", () => {
    it("uses the default 30-day TTL without a future billing period end", () => {
      expect(getCycleExpireSeconds(undefined, 1_000)).toBe(30 * 24 * 60 * 60);
      expect(getCycleExpireSeconds(999, 1_000)).toBe(30 * 24 * 60 * 60);
    });

    it("keeps buckets alive through longer billing periods", () => {
      const now = 1_000;
      const periodEnd = now + 31 * 24 * 60 * 60;

      expect(getCycleExpireSeconds(periodEnd, now)).toBe(32 * 24 * 60 * 60);
    });
  });

  describe("isUserRateLimitKey", () => {
    const userId = "user_123";

    it("matches all rate-limit namespaces owned by the user", () => {
      expect(isUserRateLimitKey(`usage:monthly:${userId}:pro`, userId)).toBe(
        true,
      );
      expect(isUserRateLimitKey(`upgrade:carryover:${userId}`, userId)).toBe(
        true,
      );
      expect(
        isUserRateLimitKey(
          `upgrade:carryover:${userId}:in_upgrade:claim`,
          userId,
        ),
      ).toBe(true);
      expect(isUserRateLimitKey(`free_limit:${userId}:free:ask`, userId)).toBe(
        true,
      );
      expect(isUserRateLimitKey(`free_referral_bonus:${userId}`, userId)).toBe(
        true,
      );
      expect(
        isUserRateLimitKey(`free_referral_bonus_grant:ref:${userId}`, userId),
      ).toBe(true);
      expect(
        isUserRateLimitKey(`free_agent_limit:${userId}:agent`, userId),
      ).toBe(true);
      expect(
        isUserRateLimitKey(`free_monthly_cost:${userId}:2026-06`, userId),
      ).toBe(true);
      expect(isUserRateLimitKey(`free_run_lock:${userId}`, userId)).toBe(true);
      expect(
        isUserRateLimitKey(`team:debt_applied:org_123:${userId}`, userId),
      ).toBe(true);
    });

    it("rejects unrelated keys that contain the same user id", () => {
      expect(isUserRateLimitKey(`chat:${userId}:messages`, userId)).toBe(false);
      expect(
        isUserRateLimitKey(`team:removed_usage:org_${userId}`, userId),
      ).toBe(false);
      expect(isUserRateLimitKey(`usage:monthly:user_456:pro`, userId)).toBe(
        false,
      );
    });
  });

  // ==========================================================================
  // Cost calculation integration scenarios
  // ==========================================================================
  describe("cost calculation scenarios", () => {
    it("typical conversation should cost reasonable points", () => {
      // Typical: 2000 input tokens, 500 output tokens (with 1.3x multiplier)
      const inputCost = calculateTokenCost(2000, "input"); // 13 points
      const outputCost = calculateTokenCost(500, "output"); // 20 points
      const totalCost = inputCost + outputCost; // 33 points

      expect(inputCost).toBe(13);
      expect(outputCost).toBe(20);
      expect(totalCost).toBe(33);
    });

    it("pro user should afford many typical conversations per month", () => {
      const monthlyBudget = getBudgetLimits("pro").monthly;
      const typicalCost = 33; // points per conversation (with 1.3x multiplier)

      const conversationsPerMonth = Math.floor(monthlyBudget / typicalCost);
      expect(conversationsPerMonth).toBe(7575);
    });

    it("long context request should cost proportionally more", () => {
      const longContextCost = calculateTokenCost(100_000, "input"); // 650 points
      const shortContextCost = calculateTokenCost(1_000, "input"); // 7 points

      expect(longContextCost).toBe(650);
      expect(shortContextCost).toBe(7);
      expect(longContextCost).toBeGreaterThan(shortContextCost * 90);
    });

    it("heavy output request should be significantly more expensive", () => {
      // Agent generating lots of code
      const inputCost = calculateTokenCost(5000, "input"); // 33 points
      const outputCost = calculateTokenCost(10000, "output"); // 390 points

      expect(outputCost).toBeGreaterThan(inputCost * 10);
    });
  });

  // ==========================================================================
  // Proration calculation logic
  // ==========================================================================
  describe("calculateTierChangeCredits", () => {
    it("adds the prorated plan difference for an exhausted Pro→Pro+ upgrade", () => {
      const result = calculateTierChangeCredits(
        600_000,
        250_000,
        0,
        0.41581478,
      );

      expect(result).toEqual({
        consumedCredits: 250_000,
        incrementalCredits: 145_535,
        cycleAllocation: 395_535,
        remainingCredits: 145_535,
      });
    });

    it("preserves unused old credits and adds only the prorated difference", () => {
      const result = calculateTierChangeCredits(
        600_000,
        250_000,
        80_000,
        1 / 3,
      );

      expect(result).toEqual({
        consumedCredits: 170_000,
        incrementalCredits: 116_666,
        cycleAllocation: 366_666,
        remainingCredits: 196_666,
      });
    });

    it("uses the stored cycle allocation for grandfathered plans", () => {
      const result = calculateTierChangeCredits(600_000, 200_000, 50_000, 0.5);

      expect(result).toEqual({
        consumedCredits: 150_000,
        incrementalCredits: 200_000,
        cycleAllocation: 400_000,
        remainingCredits: 250_000,
      });
    });

    it("caps a downgrade without restoring consumed usage", () => {
      const result = calculateTierChangeCredits(250_000, 600_000, 400_000, 0.5);

      expect(result).toEqual({
        consumedCredits: 200_000,
        incrementalCredits: 0,
        cycleAllocation: 250_000,
        remainingCredits: 50_000,
      });
    });

    it("clamps invalid remaining credits and proration ratios", () => {
      expect(calculateTierChangeCredits(600_000, 250_000, 999_999, 2)).toEqual({
        consumedCredits: 0,
        incrementalCredits: 350_000,
        cycleAllocation: 600_000,
        remainingCredits: 600_000,
      });
    });
  });

  // ==========================================================================
  // Per-model pricing - calculateTokenCost with modelName parameter
  // ==========================================================================
  describe("per-model pricing", () => {
    it("should use default pricing when no modelName is provided", () => {
      // Default: $0.50 input, $3.00 output (with 1.3x multiplier)
      expect(calculateTokenCost(1_000_000, "input")).toBe(6500);
      expect(calculateTokenCost(1_000_000, "output")).toBe(39000);
    });

    it("should use default pricing for unknown model names", () => {
      expect(calculateTokenCost(1_000_000, "input", "unknown-model")).toBe(
        6500,
      );
      expect(calculateTokenCost(1_000_000, "output", "unknown-model")).toBe(
        39000,
      );
    });

    it("should use DeepSeek V4 Pro pricing ($0.435/$0.87)", () => {
      expect(
        calculateTokenCost(1_000_000, "input", "model-deepseek-v4-pro"),
      ).toBe(5655);
      expect(
        calculateTokenCost(1_000_000, "output", "model-deepseek-v4-pro"),
      ).toBe(11310);
      expect(
        calculateTokenCost(1_000_000, "input", "model-deepseek-v4-pro-0813"),
      ).toBe(5655);
      expect(
        calculateTokenCost(
          1_000_000,
          "output",
          "deepseek/deepseek-v4-pro-0813",
        ),
      ).toBe(11310);
    });

    it("should use DeepSeek V4 Flash 0731 pricing ($0.14/$0.28)", () => {
      expect(
        calculateTokenCost(1_000_000, "input", "model-deepseek-v4-flash-0731"),
      ).toBe(1820);
      expect(
        calculateTokenCost(1_000_000, "output", "model-deepseek-v4-flash-0731"),
      ).toBe(3640);
    });

    it("should use GLM 5.2 baseline pricing ($0.76/$2.42)", () => {
      expect(calculateTokenCost(1_000_000, "input", "model-glm-5.2")).toBe(
        9880,
      );
      expect(calculateTokenCost(1_000_000, "output", "model-glm-5.2")).toBe(
        31460,
      );
    });

    it.each(["model-kimi-k3", "model-opus-4.6"])(
      "should use Kimi K3 pricing for %s ($3.00/$15.00)",
      (modelName) => {
        expect(calculateTokenCost(1_000_000, "input", modelName)).toBe(39000);
        expect(calculateTokenCost(1_000_000, "output", modelName)).toBe(195000);
      },
    );

    it.each([
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-v4-flash-20260423",
    ])(
      "should use previous DeepSeek V4 Flash pricing for %s ($0.09/$0.18)",
      (modelName) => {
        expect(calculateTokenCost(1_000_000, "input", modelName)).toBe(1170);
        expect(calculateTokenCost(1_000_000, "output", modelName)).toBe(2340);
      },
    );

    it.each([
      "ask-model-free",
      "agent-model-free",
      "deepseek/deepseek-v4-flash-0731",
      "deepseek/deepseek-v4-flash-20260731",
    ])(
      "should use DeepSeek V4 Flash 0731 pricing for %s ($0.14/$0.28)",
      (modelName) => {
        expect(calculateTokenCost(1_000_000, "input", modelName)).toBe(1820);
        expect(calculateTokenCost(1_000_000, "output", modelName)).toBe(3640);
      },
    );

    it.each([
      "x-ai/grok-4.5",
      "x-ai/grok-4.6",
      "x-ai/grok-4.5-20260708",
      "model-grok-4.6",
      "model-grok-4.6-pro",
      "model-grok-4.5",
      "model-grok-4.5-pro",
      "ask-model",
      "agent-model",
      "fallback-agent-model",
      "fallback-ask-model",
      "agent-auto-review-model",
    ])("should use Grok base pricing for %s ($2.00/$6.00)", (modelName) => {
      expect(calculateTokenCost(100_000, "input", modelName)).toBe(2600);
      expect(calculateTokenCost(1_000_000, "output", modelName)).toBe(78000);
    });

    it("uses Grok 4.6 base pricing below 200k prompt tokens", () => {
      expect(
        calculateRawModelUsageCostDollars({
          inputTokens: 199_999,
          outputTokens: 10_000,
          modelName: "model-grok-4.6-pro",
        }),
      ).toBeCloseTo(0.459998);
    });

    it("uses Grok 4.6 doubled pricing from 200k prompt tokens", () => {
      expect(
        calculateRawModelUsageCostDollars({
          inputTokens: 200_000,
          outputTokens: 10_000,
          modelName: "x-ai/grok-4.6",
        }),
      ).toBeCloseTo(0.92);
      expect(
        calculateTokenCost(10_000, "output", "model-grok-4.6-pro", 200_000),
      ).toBe(1560);
    });

    it("keeps Grok 4.5 Pro on flat pricing above 200k prompt tokens", () => {
      expect(
        calculateRawModelUsageCostDollars({
          inputTokens: 200_000,
          outputTokens: 10_000,
          modelName: "model-grok-4.5-pro",
        }),
      ).toBeCloseTo(0.46);
    });

    it("higher-priced models should deplete budget faster", () => {
      const monthlyBudget = getBudgetLimits("pro").monthly;
      // Typical conversation: 2000 input + 500 output tokens
      const defaultCost =
        calculateTokenCost(2000, "input") + calculateTokenCost(500, "output");
      const kimiK3Cost =
        calculateTokenCost(2000, "input", "model-kimi-k3") +
        calculateTokenCost(500, "output", "model-kimi-k3");

      const defaultConversations = Math.floor(monthlyBudget / defaultCost);
      const kimiK3Conversations = Math.floor(monthlyBudget / kimiK3Cost);

      expect(defaultConversations).toBeGreaterThan(kimiK3Conversations);
    });
  });

  // ==========================================================================
  // Team seat rotation protection - budget constants
  // ==========================================================================
  describe("team seat rotation protection", () => {
    it("team tier should have 400k monthly credits ($40)", () => {
      const teamLimits = getBudgetLimits("team");
      expect(teamLimits.monthly).toBe(400_000);
    });

    it("team member consuming all credits should equal tier max", () => {
      const teamMax = getBudgetLimits("team").monthly;
      // consumed = teamMax - remaining; when remaining=0, consumed=teamMax
      const consumed = teamMax - 0;
      expect(consumed).toBe(400_000);
    });

    it("partial consumption should be correctly calculated", () => {
      const teamMax = getBudgetLimits("team").monthly;
      const remaining = 150_000;
      const consumed = teamMax - remaining;
      expect(consumed).toBe(250_000);
    });

    it("seat debt should be capped at one seat's worth (400k)", () => {
      const teamMax = getBudgetLimits("team").monthly;
      // Even if org debt is 800k (2 members removed), each new member absorbs at most 400k
      const orgDebt = 800_000;
      const debit = Math.min(orgDebt, teamMax);
      expect(debit).toBe(400_000);
    });

    it("seat debt should handle zero remaining debt", () => {
      const orgDebt = 0;
      const teamMax = getBudgetLimits("team").monthly;
      const debit = Math.min(orgDebt, teamMax);
      expect(debit).toBe(0);
    });
  });
});
