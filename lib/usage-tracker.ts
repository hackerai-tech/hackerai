import { logUsageRecord } from "@/lib/db/actions";
import { calculateTokenCost, POINTS_PER_DOLLAR } from "@/lib/rate-limit";
import type { RateLimitInfo } from "@/types";

interface StepUsage {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: {
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  raw?: { cost?: number };
}

/**
 * Tracks accumulated token usage across stream steps and handles logging.
 * Shared between chat-handler.ts and agent-task.ts to avoid duplication.
 */
export class UsageTracker {
  inputTokens = 0;
  outputTokens = 0;
  cacheReadTokens = 0;
  cacheWriteTokens = 0;
  providerCost = 0;
  lastStepInputTokens = 0;
  /** Output tokens from summarization (not from assistant responses) */
  summarizationOutputTokens = 0;

  accumulateStep(usage: StepUsage) {
    this.inputTokens += usage.inputTokens || 0;
    this.outputTokens += usage.outputTokens || 0;
    this.lastStepInputTokens = usage.inputTokens || 0;
    this.cacheReadTokens += usage.inputTokenDetails?.cacheReadTokens || 0;
    this.cacheWriteTokens += usage.inputTokenDetails?.cacheWriteTokens || 0;
    const stepCost = usage.raw?.cost;
    if (stepCost) {
      this.providerCost += stepCost;
    }
  }

  /** Output tokens from the streamed response only (excludes summarization) */
  get streamOutputTokens(): number {
    return this.outputTokens - this.summarizationOutputTokens;
  }

  get hasUsage(): boolean {
    return (
      this.inputTokens > 0 || this.outputTokens > 0 || this.providerCost > 0
    );
  }

  computeCostDollars(selectedModel: string): number {
    if (this.providerCost > 0) return this.providerCost;
    return (
      (calculateTokenCost(this.inputTokens, "input", selectedModel) +
        calculateTokenCost(this.outputTokens, "output", selectedModel)) /
      POINTS_PER_DOLLAR
    );
  }

  resolveUsageType(rateLimitInfo: RateLimitInfo): "included" | "extra" {
    return rateLimitInfo.extraUsagePointsDeducted &&
      rateLimitInfo.extraUsagePointsDeducted > 0
      ? "extra"
      : "included";
  }

  resolveModelName({
    selectedModelOverride,
    responseModel,
    configuredModelId,
    selectedModel,
  }: {
    selectedModelOverride?: string | null;
    responseModel?: string;
    configuredModelId: string;
    selectedModel: string;
  }): string {
    if (!selectedModelOverride || selectedModelOverride === "auto") {
      return "auto";
    }
    return responseModel || configuredModelId || selectedModel;
  }

  log({
    userId,
    selectedModel,
    selectedModelOverride,
    responseModel,
    configuredModelId,
    rateLimitInfo,
  }: {
    userId: string;
    selectedModel: string;
    selectedModelOverride?: string | null;
    responseModel?: string;
    configuredModelId: string;
    rateLimitInfo: RateLimitInfo;
  }) {
    logUsageRecord({
      userId,
      model: this.resolveModelName({
        selectedModelOverride,
        responseModel,
        configuredModelId,
        selectedModel,
      }),
      type: this.resolveUsageType(rateLimitInfo),
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens || undefined,
      cacheWriteTokens: this.cacheWriteTokens || undefined,
      costDollars: this.computeCostDollars(selectedModel),
    });
  }
}
