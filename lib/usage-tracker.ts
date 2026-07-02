import { logUsageRecord } from "@/lib/db/actions";
import { calculateRawTokenCost, POINTS_PER_DOLLAR } from "@/lib/rate-limit";
import type { ChatMode, RateLimitInfo, SubscriptionTier } from "@/types";

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

export type UsageBillingType = "included" | "extra" | "mixed";

export interface UsageBillingBreakdown {
  includedPointsDeducted: number;
  extraUsagePointsDeducted: number;
  uncoveredPoints?: number;
  usageDeductionFailed?: boolean;
  usageDeductionFailureReason?: string;
}

interface ResolvedUsageBillingBreakdown extends UsageBillingBreakdown {
  includedPointsDeducted: number;
  extraUsagePointsDeducted: number;
  uncoveredPoints: number;
  usageDeductionFailed: boolean;
}

export interface UsageCostRecord {
  model: string;
  type: UsageBillingType;
  includedCostDollars: number;
  extraUsageCostDollars: number;
  uncoveredCostDollars: number;
  includedPointsDeducted: number;
  extraUsagePointsDeducted: number;
  uncoveredPoints: number;
  usageDeductionFailed: boolean;
  usageDeductionFailureReason?: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costDollars: number;
  modelCostDollars: number;
  nonModelCostDollars: number;
  costSource: "provider" | "token_estimate" | "raw_token_estimate";
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

  computeModelCostDollars(
    selectedModel: string,
    accountingModel?: string,
  ): number {
    // Use authoritative per-step provider cost only when the model itself
    // reported one via raw.cost (tracked in modelProviderCost). providerCost
    // also includes sandbox/tool spend and summarization cost, so subtract
    // nonModelCost to isolate the model portion.
    if (this.modelProviderCost > 0) {
      return this.providerCost - this.nonModelCost;
    }
    const modelForEstimate = accountingModel ?? selectedModel;
    return (
      (calculateRawTokenCost(this.inputTokens, "input", modelForEstimate) +
        calculateRawTokenCost(this.outputTokens, "output", modelForEstimate)) /
      POINTS_PER_DOLLAR
    );
  }

  computeCostDollars(selectedModel: string, accountingModel?: string): number {
    // Mirror deductUsage's gate: providerCost is only authoritative for the
    // total when modelProviderCost > 0. After resetModelLeg() (fallback retry)
    // providerCost can be positive from nonModelCost alone, which would
    // underreport the fallback's model tokens if we used it directly.
    if (this.modelProviderCost > 0) return this.providerCost;
    return (
      this.computeModelCostDollars(selectedModel, accountingModel) +
      this.nonModelCost
    );
  }

  getBillingBreakdown(
    rateLimitInfo: RateLimitInfo,
    billingBreakdown?: UsageBillingBreakdown,
  ): ResolvedUsageBillingBreakdown {
    return {
      includedPointsDeducted: Math.max(
        0,
        billingBreakdown?.includedPointsDeducted ??
          rateLimitInfo.pointsDeducted ??
          0,
      ),
      extraUsagePointsDeducted: Math.max(
        0,
        billingBreakdown?.extraUsagePointsDeducted ??
          rateLimitInfo.extraUsagePointsDeducted ??
          0,
      ),
      uncoveredPoints: Math.max(0, billingBreakdown?.uncoveredPoints ?? 0),
      usageDeductionFailed:
        billingBreakdown?.usageDeductionFailed === true ||
        (billingBreakdown?.uncoveredPoints ?? 0) > 0,
      usageDeductionFailureReason:
        billingBreakdown?.usageDeductionFailureReason,
    };
  }

  resolveUsageType(
    rateLimitInfo: RateLimitInfo,
    billingBreakdown?: UsageBillingBreakdown,
  ): UsageBillingType {
    const { includedPointsDeducted, extraUsagePointsDeducted } =
      this.getBillingBreakdown(rateLimitInfo, billingBreakdown);
    if (includedPointsDeducted > 0 && extraUsagePointsDeducted > 0) {
      return "mixed";
    }
    return extraUsagePointsDeducted > 0 ? "extra" : "included";
  }

  resolveCostBreakdown(
    costDollars: number,
    rateLimitInfo: RateLimitInfo,
    billingBreakdown?: UsageBillingBreakdown,
  ): Pick<
    UsageCostRecord,
    | "includedCostDollars"
    | "extraUsageCostDollars"
    | "uncoveredCostDollars"
    | "includedPointsDeducted"
    | "extraUsagePointsDeducted"
    | "uncoveredPoints"
    | "usageDeductionFailed"
    | "usageDeductionFailureReason"
  > {
    const {
      includedPointsDeducted,
      extraUsagePointsDeducted,
      uncoveredPoints,
      usageDeductionFailed,
      usageDeductionFailureReason,
    } = this.getBillingBreakdown(rateLimitInfo, billingBreakdown);
    const totalPoints =
      includedPointsDeducted + extraUsagePointsDeducted + uncoveredPoints;

    if (totalPoints <= 0) {
      return {
        includedCostDollars: costDollars,
        extraUsageCostDollars: 0,
        uncoveredCostDollars: 0,
        includedPointsDeducted,
        extraUsagePointsDeducted,
        uncoveredPoints,
        usageDeductionFailed,
        usageDeductionFailureReason,
      };
    }

    const includedCostDollars =
      costDollars * (includedPointsDeducted / totalPoints);
    const extraUsageCostDollars =
      costDollars * (extraUsagePointsDeducted / totalPoints);
    const uncoveredCostDollars =
      costDollars - includedCostDollars - extraUsageCostDollars;
    return {
      includedCostDollars,
      extraUsageCostDollars,
      uncoveredCostDollars,
      includedPointsDeducted,
      extraUsagePointsDeducted,
      uncoveredPoints,
      usageDeductionFailed,
      usageDeductionFailureReason,
    };
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

  createUsageCostRecord({
    selectedModel,
    selectedModelOverride,
    responseModel,
    configuredModelId,
    accountingModel,
    rateLimitInfo,
    billingBreakdown,
  }: {
    selectedModel: string;
    selectedModelOverride?: string | null;
    responseModel?: string;
    configuredModelId: string;
    accountingModel?: string;
    rateLimitInfo: RateLimitInfo;
    billingBreakdown?: UsageBillingBreakdown;
  }): UsageCostRecord {
    const model = this.resolveModelName({
      selectedModelOverride,
      responseModel,
      configuredModelId,
      selectedModel,
    });
    const modelCostDollars = this.computeModelCostDollars(
      selectedModel,
      accountingModel,
    );
    const costDollars = modelCostDollars + this.nonModelCost;
    const costBreakdown = this.resolveCostBreakdown(
      costDollars,
      rateLimitInfo,
      billingBreakdown,
    );
    return {
      model,
      type: this.resolveUsageType(rateLimitInfo, billingBreakdown),
      ...costBreakdown,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens: this.totalTokens || this.inputTokens + this.outputTokens,
      cacheReadTokens: this.cacheReadTokens || undefined,
      cacheWriteTokens: this.cacheWriteTokens || undefined,
      costDollars,
      modelCostDollars,
      nonModelCostDollars: this.nonModelCost,
      costSource:
        this.modelProviderCost > 0 ? "provider" : "raw_token_estimate",
    };
  }

  log(args: {
    userId: string;
    organizationId?: string;
    chatId?: string;
    endpoint?: "/api/chat" | "/api/agent-long";
    mode?: ChatMode;
    subscription?: SubscriptionTier;
    selectedModel: string;
    selectedModelOverride?: string | null;
    responseModel?: string;
    configuredModelId: string;
    accountingModel?: string;
    rateLimitInfo: RateLimitInfo;
    billingBreakdown?: UsageBillingBreakdown;
  }) {
    const usage = this.createUsageCostRecord(args);
    logUsageRecord({
      userId: args.userId,
      organizationId: args.organizationId,
      chatId: args.chatId,
      endpoint: args.endpoint,
      mode: args.mode,
      subscription: args.subscription,
      model: usage.model,
      type: usage.type,
      includedCostDollars: usage.includedCostDollars,
      extraUsageCostDollars: usage.extraUsageCostDollars,
      includedPointsDeducted: usage.includedPointsDeducted,
      extraUsagePointsDeducted: usage.extraUsagePointsDeducted,
      uncoveredCostDollars: usage.uncoveredCostDollars,
      uncoveredPoints: usage.uncoveredPoints,
      usageDeductionFailed: usage.usageDeductionFailed,
      usageDeductionFailureReason: usage.usageDeductionFailureReason,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      costDollars: usage.costDollars,
      modelCostDollars: usage.modelCostDollars,
      nonModelCostDollars: usage.nonModelCostDollars,
      costSource: usage.costSource,
    });
  }
}
