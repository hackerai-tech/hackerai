import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { UsageTracker } from "../usage-tracker";

describe("UsageTracker", () => {
  let tracker: UsageTracker;

  beforeEach(() => {
    tracker = new UsageTracker();
    jest.clearAllMocks();
  });

  describe("accumulateStep", () => {
    it("should sum tokens across multiple steps", () => {
      tracker.accumulateStep({
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      });
      tracker.accumulateStep({
        inputTokens: 200,
        outputTokens: 75,
        totalTokens: 275,
      });

      expect(tracker.inputTokens).toBe(300);
      expect(tracker.outputTokens).toBe(125);
      expect(tracker.totalTokens).toBe(425);
    });

    it("should accumulate cache tokens", () => {
      tracker.accumulateStep({
        inputTokens: 100,
        outputTokens: 50,
        inputTokenDetails: { cacheReadTokens: 30, cacheWriteTokens: 10 },
      });
      tracker.accumulateStep({
        inputTokens: 100,
        outputTokens: 50,
        inputTokenDetails: { cacheReadTokens: 20 },
      });

      expect(tracker.cacheReadTokens).toBe(50);
      expect(tracker.cacheWriteTokens).toBe(10);
    });

    it("should accumulate provider cost", () => {
      tracker.accumulateStep({
        inputTokens: 100,
        outputTokens: 50,
        raw: { cost: 0.001 },
      });
      tracker.accumulateStep({
        inputTokens: 100,
        outputTokens: 50,
        raw: { cost: 0.002 },
      });

      expect(tracker.providerCost).toBeCloseTo(0.003);
    });

    it("should track lastStepInputTokens from most recent step", () => {
      tracker.accumulateStep({ inputTokens: 100, outputTokens: 0 });
      tracker.accumulateStep({ inputTokens: 200, outputTokens: 0 });

      expect(tracker.lastStepInputTokens).toBe(200);
    });

    it("should handle missing fields gracefully", () => {
      tracker.accumulateStep({});

      expect(tracker.inputTokens).toBe(0);
      expect(tracker.outputTokens).toBe(0);
      expect(tracker.providerCost).toBe(0);
    });
  });

  describe("streamOutputTokens", () => {
    it("should exclude summarization tokens from output", () => {
      tracker.accumulateStep({ inputTokens: 0, outputTokens: 500 });
      tracker.summarizationOutputTokens = 100;

      expect(tracker.streamOutputTokens).toBe(400);
    });

    it("should return all output tokens when no summarization", () => {
      tracker.accumulateStep({ inputTokens: 0, outputTokens: 500 });

      expect(tracker.streamOutputTokens).toBe(500);
    });
  });

  describe("hasUsage", () => {
    it("should return false when all zeros", () => {
      expect(tracker.hasUsage).toBe(false);
    });

    it("should return true when inputTokens > 0", () => {
      tracker.accumulateStep({ inputTokens: 1 });
      expect(tracker.hasUsage).toBe(true);
    });

    it("should return true when outputTokens > 0", () => {
      tracker.accumulateStep({ outputTokens: 1 });
      expect(tracker.hasUsage).toBe(true);
    });

    it("should return true when providerCost > 0", () => {
      tracker.accumulateStep({ raw: { cost: 0.001 } });
      expect(tracker.hasUsage).toBe(true);
    });
  });

  describe("cacheHitRate", () => {
    it("should return null when no cache data", () => {
      expect(tracker.cacheHitRate).toBeNull();
    });

    it("should return null when both cache tokens are zero", () => {
      tracker.accumulateStep({ inputTokens: 100, outputTokens: 50 });
      expect(tracker.cacheHitRate).toBeNull();
    });

    it("should compute hit rate as reads / (reads + writes)", () => {
      tracker.accumulateStep({
        inputTokens: 100,
        inputTokenDetails: { cacheReadTokens: 80, cacheWriteTokens: 20 },
      });
      expect(tracker.cacheHitRate).toBe(0.8);
    });

    it("should return 0 when all writes and no reads", () => {
      tracker.accumulateStep({
        inputTokens: 100,
        inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 50 },
      });
      expect(tracker.cacheHitRate).toBe(0);
    });

    it("should return 1 when all reads and no writes", () => {
      tracker.accumulateStep({
        inputTokens: 100,
        inputTokenDetails: { cacheReadTokens: 100, cacheWriteTokens: 0 },
      });
      expect(tracker.cacheHitRate).toBe(1);
    });

    it("should accumulate across steps", () => {
      tracker.accumulateStep({
        inputTokens: 100,
        inputTokenDetails: { cacheReadTokens: 60, cacheWriteTokens: 40 },
      });
      tracker.accumulateStep({
        inputTokens: 100,
        inputTokenDetails: { cacheReadTokens: 40, cacheWriteTokens: 10 },
      });
      // total: reads=100, writes=50 → rate = 100/150 ≈ 0.667
      expect(tracker.cacheHitRate).toBeCloseTo(0.667, 2);
    });
  });

  describe("hasCacheData", () => {
    it("should return false when no cache tokens", () => {
      expect(tracker.hasCacheData).toBe(false);
    });

    it("should return true when cache read tokens exist", () => {
      tracker.accumulateStep({
        inputTokens: 100,
        inputTokenDetails: { cacheReadTokens: 10 },
      });
      expect(tracker.hasCacheData).toBe(true);
    });

    it("should return true when cache write tokens exist", () => {
      tracker.accumulateStep({
        inputTokens: 100,
        inputTokenDetails: { cacheWriteTokens: 10 },
      });
      expect(tracker.hasCacheData).toBe(true);
    });
  });

  describe("computeCostDollars", () => {
    it("should use providerCost when available", () => {
      tracker.accumulateStep({
        inputTokens: 1000,
        outputTokens: 500,
        raw: { cost: 0.05 },
      });

      expect(tracker.computeCostDollars("model-default")).toBe(0.05);
    });

    it("should use authoritative model cost from provider metadata when raw cost is missing", () => {
      const stepCostIndex = tracker.accumulateStep({
        inputTokens: 12,
        outputTokens: 4,
        raw: { cost: 0 },
      });
      tracker.setAuthoritativeModelCostForStep(stepCostIndex, 0.00016);

      expect(tracker.computeModelCostDollars("model-default")).toBe(0.00016);
      expect(tracker.computeCostDollars("model-default")).toBe(0.00016);
    });

    it("should sum authoritative metadata costs across model steps", () => {
      const firstStepCostIndex = tracker.accumulateStep({
        inputTokens: 12,
        outputTokens: 4,
        raw: { cost: 0 },
      });
      const secondStepCostIndex = tracker.accumulateStep({
        inputTokens: 20,
        outputTokens: 5,
        raw: { cost: 0 },
      });

      tracker.setAuthoritativeModelCostForStep(firstStepCostIndex, 0.00016);
      tracker.setAuthoritativeModelCostForStep(secondStepCostIndex, 0.0002);

      expect(tracker.computeModelCostDollars("model-default")).toBeCloseTo(
        0.00036,
      );
      expect(tracker.computeCostDollars("model-default")).toBeCloseTo(0.00036);
    });

    it("should use token estimates when any model step lacks authoritative cost", () => {
      const firstStepCostIndex = tracker.accumulateStep({
        inputTokens: 500_000,
        outputTokens: 0,
        raw: { cost: 0 },
      });
      tracker.accumulateStep({
        inputTokens: 500_000,
        outputTokens: 0,
        raw: { cost: 0 },
      });

      tracker.setAuthoritativeModelCostForStep(firstStepCostIndex, 0.00016);

      expect(tracker.computeCostDollars("model-default")).toBe(0.5);
    });

    it("should prefer authoritative metadata cost over raw provider cost while preserving non-model spend", () => {
      const stepCostIndex = tracker.accumulateStep({
        inputTokens: 1000,
        outputTokens: 500,
        raw: { cost: 0.05 },
      });
      tracker.providerCost += 0.01;
      tracker.nonModelCost = 0.01;
      tracker.setAuthoritativeModelCostForStep(stepCostIndex, 0.00016);

      expect(tracker.modelProviderCost).toBeCloseTo(0.00016);
      expect(tracker.computeModelCostDollars("model-default")).toBeCloseTo(
        0.00016,
      );
      expect(tracker.computeCostDollars("model-default")).toBeCloseTo(0.01016);
    });

    it("should ignore non-positive metadata cost", () => {
      const stepCostIndex = tracker.accumulateStep({
        inputTokens: 1000,
        outputTokens: 500,
        raw: { cost: 0.05 },
      });

      tracker.setAuthoritativeModelCostForStep(stepCostIndex, 0);
      tracker.setAuthoritativeModelCostForStep(stepCostIndex, Number.NaN);

      expect(tracker.computeCostDollars("model-default")).toBe(0.05);
    });

    it("should fall back to token calculation when no provider cost", () => {
      tracker.accumulateStep({ inputTokens: 1_000_000, outputTokens: 0 });

      const cost = tracker.computeCostDollars("model-default");
      // 1M input tokens at $0.50/1M, excluding the billing multiplier.
      expect(cost).toBe(0.5);
    });

    it("should include non-model costs when provider cost is unavailable", () => {
      tracker.accumulateStep({ inputTokens: 1_000_000, outputTokens: 0 });
      tracker.nonModelCost = 0.25;

      expect(tracker.computeCostDollars("model-default")).toBe(0.75);
    });

    it("should use token-based model cost + nonModelCost when modelProviderCost is 0 but providerCost is positive from sandbox/tool spend (post-resetModelLeg scenario)", () => {
      // Simulate the state after resetModelLeg() has stripped the primary
      // leg's model cost and the fallback leg ran without reporting raw.cost.
      tracker.accumulateStep({ inputTokens: 1_000_000, outputTokens: 0 });
      tracker.providerCost = 0.25; // nonModelCost baked in
      tracker.nonModelCost = 0.25;
      // modelProviderCost stays 0 because the fallback provider didn't emit cost.

      // Must include BOTH the raw token-based model cost (0.50) AND the sandbox
      // spend (0.25). The old implementation returned just providerCost = 0.25.
      expect(tracker.computeCostDollars("model-default")).toBe(0.75);
    });
  });

  describe("resolveUsageType", () => {
    it("should return 'extra' when extraUsagePointsDeducted > 0", () => {
      const result = tracker.resolveUsageType({
        remaining: 0,
        resetTime: new Date(),
        limit: 250000,
        pointsDeducted: 0,
        extraUsagePointsDeducted: 50,
      });
      expect(result).toBe("extra");
    });

    it("should return 'mixed' when included and extra usage were both used", () => {
      const result = tracker.resolveUsageType({
        remaining: 0,
        resetTime: new Date(),
        limit: 250000,
        pointsDeducted: 100,
        extraUsagePointsDeducted: 50,
      });
      expect(result).toBe("mixed");
    });

    it("should return 'included' when no extra usage", () => {
      const result = tracker.resolveUsageType({
        remaining: 1000,
        resetTime: new Date(),
        limit: 250000,
        pointsDeducted: 100,
      });
      expect(result).toBe("included");
    });

    it("should return 'included' when extraUsagePointsDeducted is 0", () => {
      const result = tracker.resolveUsageType({
        remaining: 1000,
        resetTime: new Date(),
        limit: 250000,
        pointsDeducted: 100,
        extraUsagePointsDeducted: 0,
      });
      expect(result).toBe("included");
    });

    it("should return 'extra' when only uncovered usage remains", () => {
      const result = tracker.resolveUsageType(
        {
          remaining: 0,
          resetTime: new Date(),
          limit: 250000,
          pointsDeducted: 0,
        },
        {
          includedPointsDeducted: 0,
          extraUsagePointsDeducted: 0,
          uncoveredPoints: 50,
        },
      );
      expect(result).toBe("extra");
    });

    it("should return 'mixed' when included and uncovered usage were both used", () => {
      const result = tracker.resolveUsageType(
        {
          remaining: 0,
          resetTime: new Date(),
          limit: 250000,
          pointsDeducted: 50,
        },
        {
          includedPointsDeducted: 50,
          extraUsagePointsDeducted: 0,
          uncoveredPoints: 50,
        },
      );
      expect(result).toBe("mixed");
    });
  });

  describe("resolveCostBreakdown", () => {
    it("splits cost proportionally across included and extra points", () => {
      const result = tracker.resolveCostBreakdown(
        3,
        {
          remaining: 0,
          resetTime: new Date(),
          limit: 250000,
          pointsDeducted: 100,
        },
        {
          includedPointsDeducted: 100,
          extraUsagePointsDeducted: 50,
        },
      );

      expect(result).toMatchObject({
        includedPointsDeducted: 100,
        extraUsagePointsDeducted: 50,
      });
      expect(result.includedCostDollars).toBeCloseTo(2);
      expect(result.extraUsageCostDollars).toBeCloseTo(1);
      expect(result.uncoveredCostDollars).toBeCloseTo(0);
      expect(result.uncoveredPoints).toBe(0);
      expect(result.usageDeductionFailed).toBe(false);
    });

    it("splits uncovered cost away from paid extra usage", () => {
      const result = tracker.resolveCostBreakdown(
        10,
        {
          remaining: 0,
          resetTime: new Date(),
          limit: 250000,
          pointsDeducted: 0,
        },
        {
          includedPointsDeducted: 0,
          extraUsagePointsDeducted: 50_000,
          uncoveredPoints: 50_000,
          usageDeductionFailed: true,
          usageDeductionFailureReason: "insufficient_funds",
        },
      );

      expect(result.includedCostDollars).toBeCloseTo(0);
      expect(result.extraUsageCostDollars).toBeCloseTo(5);
      expect(result.uncoveredCostDollars).toBeCloseTo(5);
      expect(result.uncoveredPoints).toBe(50_000);
      expect(result.usageDeductionFailed).toBe(true);
      expect(result.usageDeductionFailureReason).toBe("insufficient_funds");
    });
  });

  describe("resolveModelName", () => {
    it("should return 'auto' when no override or override is 'auto'", () => {
      expect(
        tracker.resolveModelName({
          configuredModelId: "model-x",
          selectedModel: "model-y",
        }),
      ).toBe("auto");

      expect(
        tracker.resolveModelName({
          selectedModelOverride: "auto",
          configuredModelId: "model-x",
          selectedModel: "model-y",
        }),
      ).toBe("auto");
    });

    it("should prefer responseModel when override is set", () => {
      expect(
        tracker.resolveModelName({
          selectedModelOverride: "model-custom",
          responseModel: "model-response",
          configuredModelId: "model-config",
          selectedModel: "model-selected",
        }),
      ).toBe("model-response");
    });

    it("should fall back to configuredModelId", () => {
      expect(
        tracker.resolveModelName({
          selectedModelOverride: "model-custom",
          configuredModelId: "model-config",
          selectedModel: "model-selected",
        }),
      ).toBe("model-config");
    });

    it("should fall back to selectedModel as last resort", () => {
      expect(
        tracker.resolveModelName({
          selectedModelOverride: "model-custom",
          configuredModelId: "",
          selectedModel: "model-selected",
        }),
      ).toBe("model-selected");
    });
  });

  describe("log", () => {
    it("should call logUsageRecord with resolved values", () => {
      const localMockLog = jest.fn();

      let IsolatedTracker: typeof UsageTracker;
      jest.isolateModules(() => {
        jest.doMock("@/lib/db/actions", () => ({
          logUsageRecord: localMockLog,
        }));
        jest.doMock("@/lib/rate-limit", () => ({
          calculateRawTokenCost: jest.fn(),
          POINTS_PER_DOLLAR: 10_000,
        }));
        IsolatedTracker = require("../usage-tracker").UsageTracker;
      });

      const t = new IsolatedTracker!();
      t.accumulateStep({
        inputTokens: 1000,
        outputTokens: 500,
        raw: { cost: 0.01 },
      });

      t.log({
        userId: "user-123",
        selectedModel: "model-default",
        configuredModelId: "model-config",
        rateLimitInfo: {
          remaining: 1000,
          resetTime: new Date(),
          limit: 250000,
          pointsDeducted: 100,
        },
      });

      expect(localMockLog).toHaveBeenCalledWith({
        userId: "user-123",
        organizationId: undefined,
        chatId: undefined,
        endpoint: undefined,
        mode: undefined,
        subscription: undefined,
        model: "auto",
        type: "included",
        includedCostDollars: 0.01,
        extraUsageCostDollars: 0,
        uncoveredCostDollars: 0,
        includedPointsDeducted: 100,
        extraUsagePointsDeducted: 0,
        uncoveredPoints: 0,
        usageDeductionFailed: false,
        usageDeductionFailureReason: undefined,
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
        costDollars: 0.01,
        modelCostDollars: 0.01,
        nonModelCostDollars: 0,
        costSource: "provider",
      });
    });

    it("labels token-estimated cost as a raw estimate", () => {
      tracker.accumulateStep({ inputTokens: 1_000_000, outputTokens: 0 });

      const usage = tracker.createUsageCostRecord({
        selectedModel: "model-default",
        configuredModelId: "model-config",
        rateLimitInfo: {
          remaining: 1000,
          resetTime: new Date(),
          limit: 250000,
          pointsDeducted: 100,
        },
      });

      expect(usage.costDollars).toBe(0.5);
      expect(usage.costSource).toBe("raw_token_estimate");
    });

    it("uses served fallback model pricing when raw provider cost is absent", () => {
      tracker.accumulateStep({
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      });

      const usage = tracker.createUsageCostRecord({
        selectedModel: "agent-model-free",
        accountingModel: "model-kimi-k2.7-code",
        configuredModelId: "minimax/minimax-m3",
        rateLimitInfo: {
          remaining: 1000,
          resetTime: new Date(),
          limit: 250000,
          pointsDeducted: 100,
        },
      });

      expect(usage.model).toBe("auto");
      expect(usage.modelCostDollars).toBe(4.95);
      expect(usage.costDollars).toBe(4.95);
      expect(usage.costSource).toBe("raw_token_estimate");
    });

    it("keeps raw provider cost ahead of served fallback token estimates", () => {
      tracker.accumulateStep({
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        raw: { cost: 0.42 },
      });

      const usage = tracker.createUsageCostRecord({
        selectedModel: "agent-model-free",
        accountingModel: "model-kimi-k2.7-code",
        configuredModelId: "minimax/minimax-m3",
        rateLimitInfo: {
          remaining: 1000,
          resetTime: new Date(),
          limit: 250000,
          pointsDeducted: 100,
        },
      });

      expect(usage.model).toBe("auto");
      expect(usage.modelCostDollars).toBe(0.42);
      expect(usage.costDollars).toBe(0.42);
      expect(usage.costSource).toBe("provider");
    });

    it("keeps upstream metadata cost ahead of token estimates when raw cost is zero", () => {
      const stepCostIndex = tracker.accumulateStep({
        inputTokens: 12,
        outputTokens: 4,
        raw: { cost: 0 },
      });
      tracker.setAuthoritativeModelCostForStep(stepCostIndex, 0.00016);

      const usage = tracker.createUsageCostRecord({
        selectedModel: "model-opus-4.6",
        accountingModel: "model-opus-4.6",
        configuredModelId: "anthropic/claude-4.6-opus-20260205",
        rateLimitInfo: {
          remaining: 1000,
          resetTime: new Date(),
          limit: 250000,
          pointsDeducted: 100,
        },
      });

      expect(usage.modelCostDollars).toBe(0.00016);
      expect(usage.costDollars).toBe(0.00016);
      expect(usage.costSource).toBe("provider");
    });

    it("labels post-run overflow as mixed when final deduction uses extra usage", () => {
      tracker.accumulateStep({
        inputTokens: 1_000_000,
        outputTokens: 0,
      });

      const usage = tracker.createUsageCostRecord({
        selectedModel: "model-default",
        configuredModelId: "model-config",
        rateLimitInfo: {
          remaining: 1000,
          resetTime: new Date(),
          limit: 250000,
          pointsDeducted: 100,
        },
        billingBreakdown: {
          includedPointsDeducted: 100,
          extraUsagePointsDeducted: 100,
        },
      });

      expect(usage.type).toBe("mixed");
      expect(usage.includedCostDollars).toBeCloseTo(0.25);
      expect(usage.extraUsageCostDollars).toBeCloseTo(0.25);
    });
  });
});
