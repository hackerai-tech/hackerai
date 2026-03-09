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

  describe("computeCostDollars", () => {
    it("should use providerCost when available", () => {
      tracker.accumulateStep({
        inputTokens: 1000,
        outputTokens: 500,
        raw: { cost: 0.05 },
      });

      expect(tracker.computeCostDollars("model-default")).toBe(0.05);
    });

    it("should fall back to token calculation when no provider cost", () => {
      tracker.accumulateStep({ inputTokens: 1_000_000, outputTokens: 0 });

      const cost = tracker.computeCostDollars("model-default");
      // 1M input tokens at $0.50/1M = $0.50 = 5000 points / 10000 = 0.5
      expect(cost).toBe(0.5);
    });
  });

  describe("resolveUsageType", () => {
    it("should return 'extra' when extraUsagePointsDeducted > 0", () => {
      const result = tracker.resolveUsageType({
        remaining: 0,
        resetTime: new Date(),
        limit: 250000,
        pointsDeducted: 100,
        extraUsagePointsDeducted: 50,
      });
      expect(result).toBe("extra");
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
          calculateTokenCost: jest.fn(),
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
        model: "auto",
        type: "included",
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
        costDollars: 0.01,
      });
    });
  });
});
