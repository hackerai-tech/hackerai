import { logUsageRecord } from "@/lib/db/actions";
import { calculateTokenCost, POINTS_PER_DOLLAR } from "@/lib/rate-limit";
import type { RateLimitInfo } from "@/types";

interface StepUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
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
  totalTokens = 0;
  cacheReadTokens = 0;
  cacheWriteTokens = 0;
  providerCost = 0;
  /** Model-only cost from per-step usage.raw.cost (excludes tool/sandbox spend). Used to
   * decide whether the provider reported an authoritative model cost; if zero, fall back
   * to token-based model cost calculation. */
  modelProviderCost = 0;
  /** Costs from sandbox sessions and tool usage (always accurate, even on non-clean streams) */
  nonModelCost = 0;
  lastStepInputTokens = 0;
  /** Output tokens from summarization (not from assistant responses) */
  summarizationOutputTokens = 0;

  /**
   * Discard the model leg's accumulated usage before a fallback retry runs.
   * Keeps nonModelCost (sandbox/tool spend already incurred) and summarization
   * output tokens, so the final deduction only bills the fallback model.
   */
  resetModelLeg() {
    this.providerCost -= this.modelProviderCost;
    this.modelProviderCost = 0;
    this.inputTokens = 0;
    // Preserve summarization's contribution to outputTokens so the
    // streamOutputTokens getter (outputTokens - summarizationOutputTokens)
    // never goes negative.
    this.outputTokens = this.summarizationOutputTokens;
    this.totalTokens = this.outputTokens;
    this.lastStepInputTokens = 0;
    this.cacheReadTokens = 0;
    this.cacheWriteTokens = 0;
  }

  accumulateStep(usage: StepUsage) {
    this.inputTokens += usage.inputTokens || 0;
    this.outputTokens += usage.outputTokens || 0;
    this.totalTokens += usage.totalTokens || 0;
    this.lastStepInputTokens = usage.inputTokens || 0;
    this.cacheReadTokens += usage.inputTokenDetails?.cacheReadTokens || 0;
    this.cacheWriteTokens += usage.inputTokenDetails?.cacheWriteTokens || 0;
    const stepCost = usage.raw?.cost;
    if (stepCost) {
      this.providerCost += stepCost;
      this.modelProviderCost += stepCost;
    }
  }

  /** Output tokens from the streamed response only (excludes summarization) */
  get streamOutputTokens(): number {
    return this.outputTokens - this.summarizationOutputTokens;
  }

  /** Whether any cache token data was reported by the provider */
  get hasCacheData(): boolean {
    return this.cacheReadTokens > 0 || this.cacheWriteTokens > 0;
  }

  /** Cache hit rate: proportion of cached input tokens that were reads (0–1), or null if no cache data */
  get cacheHitRate(): number | null {
    const total = this.cacheReadTokens + this.cacheWriteTokens;
    if (total === 0) return null;
    return this.cacheReadTokens / total;
  }

  get hasUsage(): boolean {
    return (
      this.inputTokens > 0 || this.outputTokens > 0 || this.providerCost > 0
    );
  }

  computeModelCostDollars(selectedModel: string): number {
    if (this.providerCost > 0) return this.providerCost;
    return (
      (calculateTokenCost(this.inputTokens, "input", selectedModel) +
        calculateTokenCost(this.outputTokens, "output", selectedModel)) /
      POINTS_PER_DOLLAR
    );
  }

  computeCostDollars(selectedModel: string): number {
    if (this.providerCost > 0) return this.providerCost;
    return this.computeModelCostDollars(selectedModel) + this.nonModelCost;
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
    byok,
    maxMode,
  }: {
    userId: string;
    selectedModel: string;
    selectedModelOverride?: string | null;
    responseModel?: string;
    configuredModelId: string;
    rateLimitInfo: RateLimitInfo;
    byok?: boolean;
    maxMode?: boolean;
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
      totalTokens: this.totalTokens || this.inputTokens + this.outputTokens,
      cacheReadTokens: this.cacheReadTokens || undefined,
      cacheWriteTokens: this.cacheWriteTokens || undefined,
      // For BYOK rows the LLM cost is on the user's OpenRouter account, not
      // the subscription bucket. Log only what the subscription actually paid
      // (sandbox + tools) so the Cost column reconciles against the bucket.
      costDollars: byok
        ? this.nonModelCost
        : this.computeCostDollars(selectedModel),
      byok,
      maxMode,
    });
  }
}
