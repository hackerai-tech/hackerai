import { describe, it, expect } from "@jest/globals";

import {
  calculateTokenCost,
  calculateProratedCredits,
  getBudgetLimits,
  getSubscriptionPrice,
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

    it("should calculate input token cost correctly ($0.50/1M tokens * 1.2x)", () => {
      // 1M input tokens = $0.50 * 1.2 = 6000 points
      expect(calculateTokenCost(1_000_000, "input")).toBe(6000);
      // 1K input tokens = ceil(0.001 * 0.5 * 10000 * 1.2) = 6 points
      expect(calculateTokenCost(1000, "input")).toBe(6);
      // 10M input tokens = $5.00 * 1.2 = 60000 points
      expect(calculateTokenCost(10_000_000, "input")).toBe(60000);
    });

    it("should calculate output token cost correctly ($3.00/1M tokens * 1.2x)", () => {
      // 1M output tokens = $3.00 * 1.2 = 36000 points
      expect(calculateTokenCost(1_000_000, "output")).toBe(36000);
      // 1K output tokens = ceil(0.001 * 3.0 * 10000 * 1.2) = 36 points
      expect(calculateTokenCost(1000, "output")).toBe(36);
      // 10M output tokens = $30.00 * 1.2 = 360000 points
      expect(calculateTokenCost(10_000_000, "output")).toBe(360000);
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
      // 10 tokens at $0.50/1M * 1.2 = fractional point → rounds up to 1
      expect(calculateTokenCost(10, "input")).toBe(1);
      // 10000 tokens at $0.50/1M * 1.2 = 60 points
      expect(calculateTokenCost(10000, "input")).toBe(60);
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

  // ==========================================================================
  // Cost calculation integration scenarios
  // ==========================================================================
  describe("cost calculation scenarios", () => {
    it("typical conversation should cost reasonable points", () => {
      // Typical: 2000 input tokens, 500 output tokens (with 1.2x multiplier)
      const inputCost = calculateTokenCost(2000, "input"); // 12 points
      const outputCost = calculateTokenCost(500, "output"); // 18 points
      const totalCost = inputCost + outputCost; // 30 points

      expect(inputCost).toBe(12);
      expect(outputCost).toBe(18);
      expect(totalCost).toBe(30);
    });

    it("pro user should afford many typical conversations per month", () => {
      const monthlyBudget = getBudgetLimits("pro").monthly;
      const typicalCost = 30; // points per conversation (with 1.2x multiplier)

      const conversationsPerMonth = Math.floor(monthlyBudget / typicalCost);
      expect(conversationsPerMonth).toBe(8333);
    });

    it("long context request should cost proportionally more", () => {
      const longContextCost = calculateTokenCost(100_000, "input"); // 600 points
      const shortContextCost = calculateTokenCost(1_000, "input"); // 6 points

      expect(longContextCost).toBe(600);
      expect(shortContextCost).toBe(6);
      expect(longContextCost).toBeGreaterThan(shortContextCost * 90);
    });

    it("heavy output request should be significantly more expensive", () => {
      // Agent generating lots of code
      const inputCost = calculateTokenCost(5000, "input"); // 28 points
      const outputCost = calculateTokenCost(10000, "output"); // 330 points

      expect(outputCost).toBeGreaterThan(inputCost * 10);
    });
  });

  // ==========================================================================
  // Proration calculation logic
  // ==========================================================================
  describe("calculateProratedCredits", () => {
    // Tier maxes for reference: pro=250k, pro-plus=600k, ultra=2M, team=400k
    // Third param is consumedCredits (deducted from prorated allocation)

    it("should give 50% credits at 50% ratio with no consumption", () => {
      const result = calculateProratedCredits(2_000_000, 0.5, 0);
      expect(result.proratedCredits).toBe(1_000_000);
      expect(result.totalCredits).toBe(1_000_000);
      expect(result.burnAmount).toBe(1_000_000);
    });

    it("should deduct consumed credits from prorated amount", () => {
      // Pro → Ultra at day 15/30, user consumed 100k of Pro credits
      const result = calculateProratedCredits(2_000_000, 0.5, 100_000);
      expect(result.proratedCredits).toBe(1_000_000);
      // total = 1M - 100k consumed = 900k
      expect(result.totalCredits).toBe(900_000);
      expect(result.burnAmount).toBe(1_100_000);
    });

    it("should not go below 0 when consumed exceeds prorated", () => {
      // User burned all 250k Pro credits, upgrades to Ultra at day 25/30
      // prorated = floor(2M * 5/30) = 333_333
      // consumed = 250_000 → 333_333 - 250_000 = 83_333
      const result = calculateProratedCredits(2_000_000, 5 / 30, 250_000);
      expect(result.totalCredits).toBe(83_333);

      // Edge: consumed > prorated → floor to 0
      const result2 = calculateProratedCredits(2_000_000, 0.1, 250_000);
      // prorated = 200k, consumed = 250k → 0
      expect(result2.totalCredits).toBe(0);
    });

    it("should cap total credits at tier max", () => {
      const result = calculateProratedCredits(250_000, 0.95, 0);
      expect(result.totalCredits).toBeLessThanOrEqual(250_000);
    });

    it("should give full credits at ratio 1.0 with no consumption", () => {
      const result = calculateProratedCredits(2_000_000, 1.0, 0);
      expect(result.totalCredits).toBe(2_000_000);
      expect(result.burnAmount).toBe(0);
    });

    it("should give 0 at ratio 0.0 with no consumption", () => {
      const result = calculateProratedCredits(2_000_000, 0.0, 0);
      expect(result.totalCredits).toBe(0);
      expect(result.burnAmount).toBe(2_000_000);
    });

    it("should handle negative consumed as 0", () => {
      const result = calculateProratedCredits(250_000, 0.5, -100);
      expect(result.totalCredits).toBe(125_000); // just prorated, no deduction
    });

    it("should return 0 for zero tier max", () => {
      const result = calculateProratedCredits(0, 0.5, 100_000);
      expect(result.totalCredits).toBe(0);
    });

    it("user burns all Pro credits day 1, upgrades to Ultra", () => {
      // Day 1 of 30 → ratio ≈ 29/30 = 0.967
      // Consumed all 250k Pro credits
      const result = calculateProratedCredits(2_000_000, 29 / 30, 250_000);
      // prorated = floor(2M * 29/30) = 1_933_333
      expect(result.proratedCredits).toBe(1_933_333);
      // total = 1_933_333 - 250_000 = 1_683_333
      expect(result.totalCredits).toBe(1_683_333);
    });

    it("Pro→Pro+ at 1/3 remaining, 170k consumed", () => {
      // Day 20 of 30 → 10 days remaining → ratio = 1/3
      // User consumed 170k of 250k Pro credits
      const result = calculateProratedCredits(600_000, 1 / 3, 170_000);
      // prorated = floor(600k * 0.333) = 200_000
      expect(result.proratedCredits).toBe(200_000);
      // total = 200k - 170k = 30k
      expect(result.totalCredits).toBe(30_000);
      expect(result.burnAmount).toBe(570_000);
    });
  });

  // ==========================================================================
  // Per-model pricing - calculateTokenCost with modelName parameter
  // ==========================================================================
  describe("per-model pricing", () => {
    it("should use default pricing when no modelName is provided", () => {
      // Default: $0.50 input, $3.00 output (with 1.2x multiplier)
      expect(calculateTokenCost(1_000_000, "input")).toBe(6000);
      expect(calculateTokenCost(1_000_000, "output")).toBe(36000);
    });

    it("should use default pricing for unknown model names", () => {
      expect(calculateTokenCost(1_000_000, "input", "unknown-model")).toBe(
        6000,
      );
      expect(calculateTokenCost(1_000_000, "output", "unknown-model")).toBe(
        36000,
      );
    });

    it("should use Sonnet 4.6 pricing ($3.00/$15.00)", () => {
      expect(calculateTokenCost(1_000_000, "input", "model-sonnet-4.6")).toBe(
        36000,
      );
      expect(calculateTokenCost(1_000_000, "output", "model-sonnet-4.6")).toBe(
        180000,
      );
    });

    it("should use Grok 4.1 pricing ($0.20/$0.50)", () => {
      expect(calculateTokenCost(1_000_000, "input", "model-grok-4.1")).toBe(
        2400,
      );
      expect(calculateTokenCost(1_000_000, "output", "model-grok-4.1")).toBe(
        6000,
      );
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
