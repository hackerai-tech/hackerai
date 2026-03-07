import { describe, it, expect } from "@jest/globals";
import { PRICING } from "@/lib/pricing/features";

import {
  calculateTokenCost,
  getBudgetLimit,
  getBudgetLimits,
} from "../token-bucket";

/**
 * Unit tests for token-bucket rate limiting pure functions.
 */
describe("token-bucket", () => {
  // ==========================================================================
  // calculateTokenCost - Core pricing logic (returns dollars)
  // ==========================================================================
  describe("calculateTokenCost", () => {
    it("should return 0 for zero or negative tokens", () => {
      expect(calculateTokenCost(0, "input")).toBe(0);
      expect(calculateTokenCost(0, "output")).toBe(0);
      expect(calculateTokenCost(-100, "input")).toBe(0);
      expect(calculateTokenCost(-100, "output")).toBe(0);
    });

    it("should calculate input token cost correctly ($0.50/1M tokens)", () => {
      expect(calculateTokenCost(1_000_000, "input")).toBe(0.5);
      expect(calculateTokenCost(1000, "input")).toBe(0.0005);
      expect(calculateTokenCost(10_000_000, "input")).toBe(5.0);
    });

    it("should calculate output token cost correctly ($3.00/1M tokens)", () => {
      expect(calculateTokenCost(1_000_000, "output")).toBe(3.0);
      expect(calculateTokenCost(1000, "output")).toBe(0.003);
      expect(calculateTokenCost(10_000_000, "output")).toBe(30.0);
    });

    it("should return small fractional dollar amounts for tiny token counts", () => {
      expect(calculateTokenCost(1, "input")).toBe(0.0000005);
      expect(calculateTokenCost(1, "output")).toBe(0.000003);
      expect(calculateTokenCost(100, "input")).toBe(0.00005);
    });

    it("output should cost 6x input (ratio of $3.00/$0.50)", () => {
      const inputCost = calculateTokenCost(1_000_000, "input");
      const outputCost = calculateTokenCost(1_000_000, "output");
      expect(outputCost / inputCost).toBe(6);
    });
  });

  // ==========================================================================
  // getBudgetLimit - Monthly budget per tier (returns dollars)
  // ==========================================================================
  describe("getBudgetLimit", () => {
    it("should return 0 for free tier", () => {
      expect(getBudgetLimit("free")).toBe(0);
    });

    it("should return monthly price for pro tier", () => {
      expect(getBudgetLimit("pro")).toBe(PRICING.pro.monthly);
    });

    it("should return monthly price for ultra tier", () => {
      expect(getBudgetLimit("ultra")).toBe(PRICING.ultra.monthly);
    });

    it("should return monthly price for team tier", () => {
      expect(getBudgetLimit("team")).toBe(PRICING.team.monthly);
    });

    it("ultra should have 8x more budget than pro", () => {
      const expectedRatio = PRICING.ultra.monthly / PRICING.pro.monthly;
      expect(getBudgetLimit("ultra") / getBudgetLimit("pro")).toBeCloseTo(
        expectedRatio,
        1,
      );
    });
  });

  // ==========================================================================
  // getBudgetLimits - Backward compat (deprecated)
  // ==========================================================================
  describe("getBudgetLimits (deprecated)", () => {
    it("should return 0 limits for free tier", () => {
      const limits = getBudgetLimits("free");
      expect(limits.session).toBe(0);
      expect(limits.weekly).toBe(0);
    });

    it("should derive session and weekly from monthly price", () => {
      const limits = getBudgetLimits("pro");
      const monthlyPrice = PRICING.pro.monthly;

      expect(limits.session).toBeCloseTo(monthlyPrice / 30, 5);
      expect(limits.weekly).toBeCloseTo((monthlyPrice * 7) / 30, 5);
    });
  });

  // ==========================================================================
  // Cost calculation integration scenarios
  // ==========================================================================
  describe("cost calculation scenarios", () => {
    it("typical conversation should cost reasonable dollar amount", () => {
      const inputCost = calculateTokenCost(2000, "input");
      const outputCost = calculateTokenCost(500, "output");
      const totalCost = inputCost + outputCost;

      expect(inputCost).toBe(0.001);
      expect(outputCost).toBe(0.0015);
      expect(totalCost).toBe(0.0025);
    });

    it("pro user should afford many typical conversations per month", () => {
      const monthlyBudget = getBudgetLimit("pro");
      const typicalCost = 0.0025;

      const conversationsPerMonth = Math.floor(monthlyBudget / typicalCost);
      expect(conversationsPerMonth).toBeGreaterThan(5000);
    });

    it("long context request should cost proportionally more", () => {
      const longContextCost = calculateTokenCost(100_000, "input");
      const shortContextCost = calculateTokenCost(1_000, "input");

      expect(longContextCost / shortContextCost).toBe(100);
    });

    it("heavy output request should be significantly more expensive", () => {
      const inputCost = calculateTokenCost(5000, "input");
      const outputCost = calculateTokenCost(10000, "output");

      expect(outputCost).toBeGreaterThan(inputCost * 10);
    });
  });

  // ==========================================================================
  // Per-model pricing
  // ==========================================================================
  describe("per-model pricing", () => {
    it("should use default pricing when no modelName is provided", () => {
      expect(calculateTokenCost(1_000_000, "input")).toBe(0.5);
      expect(calculateTokenCost(1_000_000, "output")).toBe(3.0);
    });

    it("should use default pricing for unknown model names", () => {
      expect(calculateTokenCost(1_000_000, "input", "unknown-model")).toBe(0.5);
      expect(calculateTokenCost(1_000_000, "output", "unknown-model")).toBe(
        3.0,
      );
    });

    it("should use Sonnet 4.6 pricing ($3.00/$15.00)", () => {
      expect(calculateTokenCost(1_000_000, "input", "model-sonnet-4.6")).toBe(
        3.0,
      );
      expect(calculateTokenCost(1_000_000, "output", "model-sonnet-4.6")).toBe(
        15.0,
      );
    });

    it("should use Gemini 3.1 Pro pricing ($2.00/$12.00)", () => {
      expect(
        calculateTokenCost(1_000_000, "input", "model-gemini-3.1-pro"),
      ).toBe(2.0);
      expect(
        calculateTokenCost(1_000_000, "output", "model-gemini-3.1-pro"),
      ).toBe(12.0);
    });

    it("should use Grok 4.1 pricing ($0.20/$0.50)", () => {
      expect(calculateTokenCost(1_000_000, "input", "model-grok-4.1")).toBe(
        0.2,
      );
      expect(calculateTokenCost(1_000_000, "output", "model-grok-4.1")).toBe(
        0.5,
      );
    });

    it("should use Kimi K2.5 pricing ($0.60/$3.00)", () => {
      expect(calculateTokenCost(1_000_000, "input", "model-kimi-k2.5")).toBe(
        0.6,
      );
      expect(calculateTokenCost(1_000_000, "output", "model-kimi-k2.5")).toBe(
        3.0,
      );
    });

    it("expensive models should deplete budget faster", () => {
      const monthlyBudget = getBudgetLimit("pro");
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
