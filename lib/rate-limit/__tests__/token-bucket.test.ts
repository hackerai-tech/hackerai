import { describe, it, expect } from "@jest/globals";

import {
  billableCostDollarsToPoints,
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

    it("should calculate input token cost correctly ($0.50/1M tokens * 1.4x)", () => {
      // 1M input tokens = $0.50 * 1.4 = 7000 points
      expect(calculateTokenCost(1_000_000, "input")).toBe(7000);
      // 1K input tokens = ceil(0.001 * 0.5 * 10000 * 1.4) = 7 points
      expect(calculateTokenCost(1000, "input")).toBe(7);
      // 10M input tokens = $5.00 * 1.4 = 70000 points
      expect(calculateTokenCost(10_000_000, "input")).toBe(70000);
    });

    it("should calculate output token cost correctly ($3.00/1M tokens * 1.4x)", () => {
      // 1M output tokens = $3.00 * 1.4 = 42000 points
      expect(calculateTokenCost(1_000_000, "output")).toBe(42000);
      // 1K output tokens = ceil(0.001 * 3.0 * 10000 * 1.4) = 42 points
      expect(calculateTokenCost(1000, "output")).toBe(42);
      // 10M output tokens = $30.00 * 1.4 = 420000 points
      expect(calculateTokenCost(10_000_000, "output")).toBe(420000);
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
      // 10 tokens at $0.50/1M * 1.4 = fractional point → rounds up to 1
      expect(calculateTokenCost(10, "input")).toBe(1);
      // 10000 tokens at $0.50/1M * 1.4 = 70 points
      expect(calculateTokenCost(10000, "input")).toBe(70);
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

    it("should calculate raw input token cost without the 1.4x multiplier", () => {
      expect(calculateRawTokenCost(1_000_000, "input")).toBe(5000);
      expect(calculateRawTokenCost(1000, "input")).toBe(5);
    });

    it("should calculate raw output token cost without the 1.4x multiplier", () => {
      expect(calculateRawTokenCost(1_000_000, "output")).toBe(30000);
      expect(calculateRawTokenCost(1000, "output")).toBe(30);
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
      expect(billableCostDollarsToPoints(1)).toBe(14_000);
      expect(billableCostDollarsToPoints(0.005)).toBe(70);
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
      // Typical: 2000 input tokens, 500 output tokens (with 1.4x multiplier)
      const inputCost = calculateTokenCost(2000, "input"); // 14 points
      const outputCost = calculateTokenCost(500, "output"); // 21 points
      const totalCost = inputCost + outputCost; // 35 points

      expect(inputCost).toBe(14);
      expect(outputCost).toBe(21);
      expect(totalCost).toBe(35);
    });

    it("pro user should afford many typical conversations per month", () => {
      const monthlyBudget = getBudgetLimits("pro").monthly;
      const typicalCost = 35; // points per conversation (with 1.4x multiplier)

      const conversationsPerMonth = Math.floor(monthlyBudget / typicalCost);
      expect(conversationsPerMonth).toBe(7142);
    });

    it("long context request should cost proportionally more", () => {
      const longContextCost = calculateTokenCost(100_000, "input"); // 700 points
      const shortContextCost = calculateTokenCost(1_000, "input"); // 7 points

      expect(longContextCost).toBe(700);
      expect(shortContextCost).toBe(7);
      expect(longContextCost).toBeGreaterThan(shortContextCost * 90);
    });

    it("heavy output request should be significantly more expensive", () => {
      // Agent generating lots of code
      const inputCost = calculateTokenCost(5000, "input"); // 35 points
      const outputCost = calculateTokenCost(10000, "output"); // 420 points

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
      // Default: $0.50 input, $3.00 output (with 1.4x multiplier)
      expect(calculateTokenCost(1_000_000, "input")).toBe(7000);
      expect(calculateTokenCost(1_000_000, "output")).toBe(42000);
    });

    it("should use default pricing for unknown model names", () => {
      expect(calculateTokenCost(1_000_000, "input", "unknown-model")).toBe(
        7000,
      );
      expect(calculateTokenCost(1_000_000, "output", "unknown-model")).toBe(
        42000,
      );
    });

    it("should use Sonnet 4.6 pricing ($3.00/$15.00)", () => {
      expect(calculateTokenCost(1_000_000, "input", "model-sonnet-4.6")).toBe(
        42000,
      );
      expect(calculateTokenCost(1_000_000, "output", "model-sonnet-4.6")).toBe(
        210000,
      );
    });

    it("should use DeepSeek V4 Pro pricing ($0.435/$0.87)", () => {
      expect(
        calculateTokenCost(1_000_000, "input", "model-deepseek-v4-pro"),
      ).toBe(6090);
      expect(
        calculateTokenCost(1_000_000, "output", "model-deepseek-v4-pro"),
      ).toBe(12180);
    });

    it("should use GLM 5.2 pricing ($0.9086/$2.856)", () => {
      expect(calculateTokenCost(1_000_000, "input", "model-glm-5.2")).toBe(
        12721,
      );
      expect(calculateTokenCost(1_000_000, "output", "model-glm-5.2")).toBe(
        39984,
      );
    });

    it("should use DeepSeek V4 Flash pricing for free Agent ($0.09/$0.18)", () => {
      expect(calculateTokenCost(1_000_000, "input", "agent-model-free")).toBe(
        1260,
      );
      expect(calculateTokenCost(1_000_000, "output", "agent-model-free")).toBe(
        2520,
      );
    });

    it.each([
      "model-grok-4.5",
      "model-grok-4.5-pro",
      "model-gemini-3-flash",
      "ask-model",
      "agent-model",
      "model-minimax-m3",
      "fallback-agent-model",
      "fallback-ask-model",
      "fallback-grok-4.5",
    ])("should use Grok 4.5 pricing for %s ($2.00/$6.00)", (modelName) => {
      expect(calculateTokenCost(1_000_000, "input", modelName)).toBe(28000);
      expect(calculateTokenCost(1_000_000, "output", modelName)).toBe(84000);
    });

    it("expensive models should deplete budget faster", () => {
      const monthlyBudget = getBudgetLimits("pro").monthly;
      // Typical conversation: 2000 input + 500 output tokens
      const defaultCost =
        calculateTokenCost(2000, "input") + calculateTokenCost(500, "output");
      const sonnetCost =
        calculateTokenCost(2000, "input", "model-sonnet-4.6") +
        calculateTokenCost(500, "output", "model-sonnet-4.6");

      const defaultConversations = Math.floor(monthlyBudget / defaultCost);
      const sonnetConversations = Math.floor(monthlyBudget / sonnetCost);

      expect(defaultConversations).toBeGreaterThan(sonnetConversations);
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
