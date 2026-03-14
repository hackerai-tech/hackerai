import { describe, it, expect } from "@jest/globals";

import {
  calculateTokenCost,
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

    it("should calculate input token cost correctly ($0.50/1M tokens)", () => {
      // 1M input tokens = $0.50 = 5000 points
      expect(calculateTokenCost(1_000_000, "input")).toBe(5000);
      // 1K input tokens = $0.0005 = 5 points
      expect(calculateTokenCost(1000, "input")).toBe(5);
      // 10M input tokens = $5.00 = 50000 points
      expect(calculateTokenCost(10_000_000, "input")).toBe(50000);
    });

    it("should calculate output token cost correctly ($3.00/1M tokens)", () => {
      // 1M output tokens = $3.00 = 30000 points
      expect(calculateTokenCost(1_000_000, "output")).toBe(30000);
      // 1K output tokens = $0.003 = 30 points
      expect(calculateTokenCost(1000, "output")).toBe(30);
      // 10M output tokens = $30.00 = 300000 points
      expect(calculateTokenCost(10_000_000, "output")).toBe(300000);
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
      // 10 tokens at $0.50/1M = fractional point → rounds up to 1
      expect(calculateTokenCost(10, "input")).toBe(1);
      // 10000 tokens at $0.50/1M = exactly 50 points
      expect(calculateTokenCost(10000, "input")).toBe(50);
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
      // Typical: 2000 input tokens, 500 output tokens
      const inputCost = calculateTokenCost(2000, "input"); // 10 points
      const outputCost = calculateTokenCost(500, "output"); // 15 points
      const totalCost = inputCost + outputCost; // 25 points

      expect(inputCost).toBe(10);
      expect(outputCost).toBe(15);
      expect(totalCost).toBe(25);
    });

    it("pro user should afford many typical conversations per month", () => {
      const monthlyBudget = getBudgetLimits("pro").monthly;
      const typicalCost = 25; // points per conversation

      const conversationsPerMonth = Math.floor(monthlyBudget / typicalCost);
      expect(conversationsPerMonth).toBe(10000);
    });

    it("long context request should cost proportionally more", () => {
      const longContextCost = calculateTokenCost(100_000, "input"); // 500 points
      const shortContextCost = calculateTokenCost(1_000, "input"); // 5 points

      expect(longContextCost / shortContextCost).toBe(100);
    });

    it("heavy output request should be significantly more expensive", () => {
      // Agent generating lots of code
      const inputCost = calculateTokenCost(5000, "input"); // 25 points
      const outputCost = calculateTokenCost(10000, "output"); // 300 points

      expect(outputCost).toBeGreaterThan(inputCost * 10);
    });
  });

  // ==========================================================================
  // Per-model pricing - calculateTokenCost with modelName parameter
  // ==========================================================================
  describe("per-model pricing", () => {
    it("should use default pricing when no modelName is provided", () => {
      // Default: $0.50 input, $3.00 output
      expect(calculateTokenCost(1_000_000, "input")).toBe(5000);
      expect(calculateTokenCost(1_000_000, "output")).toBe(30000);
    });

    it("should use default pricing for unknown model names", () => {
      expect(calculateTokenCost(1_000_000, "input", "unknown-model")).toBe(
        5000,
      );
      expect(calculateTokenCost(1_000_000, "output", "unknown-model")).toBe(
        30000,
      );
    });

    it("should use Sonnet 4.6 pricing ($3.00/$15.00)", () => {
      expect(calculateTokenCost(1_000_000, "input", "model-sonnet-4.6")).toBe(
        30000,
      );
      expect(calculateTokenCost(1_000_000, "output", "model-sonnet-4.6")).toBe(
        150000,
      );
    });

    it("should use Grok 4.1 pricing ($0.20/$0.50)", () => {
      expect(calculateTokenCost(1_000_000, "input", "model-grok-4.1")).toBe(
        2000,
      );
      expect(calculateTokenCost(1_000_000, "output", "model-grok-4.1")).toBe(
        5000,
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
});
