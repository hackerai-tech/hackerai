import { describe, it, expect } from "@jest/globals";
import { PRICING } from "@/lib/pricing/features";

import {
  calculateTokenCost,
  getBudgetLimits,
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
  // getBudgetLimits - Subscription tier limits
  // ==========================================================================
  describe("getBudgetLimits", () => {
    it("should return 0 limits for free tier", () => {
      const limits = getBudgetLimits("free");
      expect(limits.session).toBe(0);
      expect(limits.weekly).toBe(0);
    });

    it("should calculate pro tier limits correctly (using monthly price)", () => {
      const limits = getBudgetLimits("pro");
      const monthlyPoints = PRICING.pro.monthly * POINTS_PER_DOLLAR;

      expect(limits.session).toBe(Math.round(monthlyPoints / 30));
      expect(limits.weekly).toBe(Math.round((monthlyPoints * 7) / 30));
    });

    it("should calculate ultra tier limits correctly (using monthly price)", () => {
      const limits = getBudgetLimits("ultra");
      const monthlyPoints = PRICING.ultra.monthly * POINTS_PER_DOLLAR;

      expect(limits.session).toBe(Math.round(monthlyPoints / 30));
      expect(limits.weekly).toBe(Math.round((monthlyPoints * 7) / 30));
    });

    it("should calculate team tier limits correctly (using monthly price)", () => {
      const limits = getBudgetLimits("team");
      const monthlyPoints = PRICING.team.monthly * POINTS_PER_DOLLAR;

      expect(limits.session).toBe(Math.round(monthlyPoints / 30));
      expect(limits.weekly).toBe(Math.round((monthlyPoints * 7) / 30));
    });

    it("ultra should have ~8x more limits than pro (price ratio)", () => {
      const proLimits = getBudgetLimits("pro");
      const ultraLimits = getBudgetLimits("ultra");

      // Ratio based on monthly prices
      const expectedRatio = PRICING.ultra.monthly / PRICING.pro.monthly;
      expect(ultraLimits.session / proLimits.session).toBeCloseTo(
        expectedRatio,
        1,
      );
      expect(ultraLimits.weekly / proLimits.weekly).toBeCloseTo(
        expectedRatio,
        1,
      );
    });

    it("weekly limit should be ~7x session limit", () => {
      const proLimits = getBudgetLimits("pro");
      const ultraLimits = getBudgetLimits("ultra");

      expect(proLimits.weekly / proLimits.session).toBeCloseTo(7, 1);
      expect(ultraLimits.weekly / ultraLimits.session).toBeCloseTo(7, 1);
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

    it("pro user should afford many typical conversations per session", () => {
      const sessionBudget = getBudgetLimits("pro").session;
      const typicalCost = 25; // points per conversation

      const conversationsPerSession = Math.floor(sessionBudget / typicalCost);
      // With yearly pricing, budget is lower but still allows many conversations
      expect(conversationsPerSession).toBeGreaterThan(250);
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

    it("should use Opus 4.6 pricing ($5.00/$25.00)", () => {
      // 1M input tokens at $5.00 = 50000 points
      expect(calculateTokenCost(1_000_000, "input", "model-opus-4.6")).toBe(
        50000,
      );
      // 1M output tokens at $25.00 = 250000 points
      expect(calculateTokenCost(1_000_000, "output", "model-opus-4.6")).toBe(
        250000,
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

    it("should use Gemini 3.1 Pro pricing ($2.00/$12.00)", () => {
      expect(
        calculateTokenCost(1_000_000, "input", "model-gemini-3.1-pro"),
      ).toBe(20000);
      expect(
        calculateTokenCost(1_000_000, "output", "model-gemini-3.1-pro"),
      ).toBe(120000);
    });

    it("should use Grok 4.1 pricing ($0.20/$0.50)", () => {
      expect(calculateTokenCost(1_000_000, "input", "model-grok-4.1")).toBe(
        2000,
      );
      expect(calculateTokenCost(1_000_000, "output", "model-grok-4.1")).toBe(
        5000,
      );
    });

    it("should use Kimi K2.5 pricing ($0.60/$3.00)", () => {
      expect(calculateTokenCost(1_000_000, "input", "model-kimi-k2.5")).toBe(
        6000,
      );
      expect(calculateTokenCost(1_000_000, "output", "model-kimi-k2.5")).toBe(
        30000,
      );
    });

    it("Opus 4.6 should cost 10x more input than default", () => {
      const defaultCost = calculateTokenCost(1_000_000, "input");
      const opusCost = calculateTokenCost(1_000_000, "input", "model-opus-4.6");
      expect(opusCost / defaultCost).toBe(10); // $5.00 / $0.50
    });

    it("expensive models should deplete budget faster", () => {
      const sessionBudget = getBudgetLimits("pro").session;
      // Typical conversation: 2000 input + 500 output tokens
      const defaultCost =
        calculateTokenCost(2000, "input") + calculateTokenCost(500, "output");
      const opusCost =
        calculateTokenCost(2000, "input", "model-opus-4.6") +
        calculateTokenCost(500, "output", "model-opus-4.6");

      const defaultConversations = Math.floor(sessionBudget / defaultCost);
      const opusConversations = Math.floor(sessionBudget / opusCost);

      expect(defaultConversations).toBeGreaterThan(opusConversations);
      // Opus should allow significantly fewer conversations
      expect(opusConversations).toBeLessThan(defaultConversations / 5);
    });
  });
});
