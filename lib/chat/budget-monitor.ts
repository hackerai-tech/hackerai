import "server-only";

import type { UIMessageStreamWriter } from "ai";
import type {
  ExtraUsageConfig,
  ChatMode,
  RateLimitInfo,
  SubscriptionTier,
} from "@/types";
import { POINTS_PER_DOLLAR } from "@/lib/rate-limit";
import {
  emitTokenBucketThresholdWarning,
  type TokenBucketEmitContext,
} from "@/lib/api/chat-stream-helpers";
import { writeRateLimitWarning } from "@/lib/utils/stream-writer-utils";
import type { LimitCapReason } from "@/lib/limit-pressure";
import {
  canContinueProAgentRunWithPremium,
  PRO_AGENT_RUN_SPEND_CAP_DOLLARS,
  type AgentRunSpendCap,
  type AgentRunSpendCapHit,
} from "@/lib/chat/agent-run-spend-cap";

// 50% is intentionally omitted: at the halfway mark there's no actionable
// signal for the user, so an in-product banner is noise. The ladder gives an
// early heads-up at 75%, a stronger warning at 90%, and uses 100% for the
// cutoff or extra-usage transition.
export const BUDGET_THRESHOLDS = [75, 90, 100] as const;

export interface BudgetSnapshot {
  monthlyLimitPoints: number;
  monthlyRemainingAtStart: number;
  monthlyResetTime: Date;
  extraUsageBalanceAtStart: number;
  extraUsageAutoReload: boolean;
  extraUsageMonthlyRemainingAtStart?: number;
}

/**
 * Captures the per-request budget snapshot used by BudgetMonitor.
 * Returns null when budget enforcement should not run for this request
 * (free users, no monthly bucket, or rate limiting skipped in dev).
 */
export function captureBudgetSnapshot(args: {
  rateLimitInfo: RateLimitInfo;
  extraUsageConfig: ExtraUsageConfig | undefined;
  subscription: SubscriptionTier;
}): BudgetSnapshot | null {
  const { rateLimitInfo, extraUsageConfig, subscription } = args;
  const monthlyLimitPoints = rateLimitInfo.monthly?.limit ?? 0;
  const monthlyResetTime = rateLimitInfo.monthly?.resetTime;
  if (
    subscription === "free" ||
    monthlyLimitPoints <= 0 ||
    !monthlyResetTime ||
    rateLimitInfo.rateLimitSkipped
  ) {
    return null;
  }
  return {
    monthlyLimitPoints,
    monthlyRemainingAtStart: rateLimitInfo.monthly!.remaining,
    monthlyResetTime: monthlyResetTime!,
    extraUsageBalanceAtStart: extraUsageConfig?.balanceDollars ?? 0,
    extraUsageAutoReload: extraUsageConfig?.autoReloadEnabled ?? false,
    extraUsageMonthlyRemainingAtStart:
      extraUsageConfig?.monthlyRemainingDollars,
  };
}

export function getProAgentRunSpendCap(args: {
  snapshot: BudgetSnapshot | null;
  subscription: SubscriptionTier;
  mode: ChatMode;
}): AgentRunSpendCap | null {
  const { snapshot, subscription, mode } = args;
  if (!snapshot || subscription !== "pro" || mode !== "agent") return null;

  const monthlyRemainingDollars =
    snapshot.monthlyRemainingAtStart / POINTS_PER_DOLLAR;
  if (monthlyRemainingDollars < PRO_AGENT_RUN_SPEND_CAP_DOLLARS) return null;

  return {
    capDollars: PRO_AGENT_RUN_SPEND_CAP_DOLLARS,
    basis: "fixed_5_dollars",
  };
}

/**
 * Mid-stream budget enforcement. State lives on the monitor; the hook point
 * in chat-handler stays thin.
 *
 * Each call to `checkAfterStep` emits at most one warning (per crossed
 * threshold) and returns "abort" only when the bucket is exhausted with no
 * extra-usage cushion. The caller owns the AbortController.
 */
export class BudgetMonitor {
  private highestThresholdEmitted: number;
  private hasEmittedAgentRunSpendCap = false;

  constructor(
    private readonly snapshot: BudgetSnapshot,
    private readonly writer: UIMessageStreamWriter,
    private readonly subscription: SubscriptionTier,
    private readonly options: {
      agentRunSpendCap?: AgentRunSpendCap | null;
      extraUsageConfig?: ExtraUsageConfig;
      onAgentRunSpendCapHit?: (hit: AgentRunSpendCapHit) => void;
    } = {},
  ) {
    const startUsedPercent =
      ((snapshot.monthlyLimitPoints - snapshot.monthlyRemainingAtStart) /
        snapshot.monthlyLimitPoints) *
      100;
    this.highestThresholdEmitted =
      BUDGET_THRESHOLDS.filter((t) => startUsedPercent >= t).pop() ?? 0;
  }

  checkAfterStep(
    currentCostDollars: number,
  ): "continue" | "abort" | "abort-agent-run-spend-cap" {
    const { snapshot } = this;
    const usedSinceStartPoints = Math.ceil(
      currentCostDollars * POINTS_PER_DOLLAR,
    );
    const agentRunSpendCap = this.options.agentRunSpendCap;
    if (
      agentRunSpendCap &&
      !this.hasEmittedAgentRunSpendCap &&
      currentCostDollars >= agentRunSpendCap.capDollars
    ) {
      this.hasEmittedAgentRunSpendCap = true;
      const monthlyRemainingDollars =
        snapshot.monthlyRemainingAtStart / POINTS_PER_DOLLAR;
      const hit: AgentRunSpendCapHit = {
        runCostDollars: Math.round(currentCostDollars * 100) / 100,
        runCapDollars: Math.round(agentRunSpendCap.capDollars * 100) / 100,
        monthlyRemainingDollars:
          Math.round(monthlyRemainingDollars * 100) / 100,
        capBasis: agentRunSpendCap.basis,
        premiumContinuationAllowed: canContinueProAgentRunWithPremium(
          this.options.extraUsageConfig,
        ),
      };
      writeRateLimitWarning(this.writer, {
        warningType: "agent-run-spend-cap",
        subscription: "pro",
        mode: "agent",
        resetTime: snapshot.monthlyResetTime.toISOString(),
        runCostDollars: hit.runCostDollars,
        runCapDollars: hit.runCapDollars,
        monthlyRemainingDollars: hit.monthlyRemainingDollars,
        capBasis: hit.capBasis,
        premiumContinuationAllowed: hit.premiumContinuationAllowed,
        midStream: true,
      });
      this.options.onAgentRunSpendCapHit?.(hit);
      return "abort-agent-run-spend-cap";
    }

    const projectedUsedPoints =
      snapshot.monthlyLimitPoints -
      snapshot.monthlyRemainingAtStart +
      usedSinceStartPoints;
    const usedPercent =
      (projectedUsedPoints / snapshot.monthlyLimitPoints) * 100;

    let decision: "continue" | "abort" = "continue";

    for (const threshold of BUDGET_THRESHOLDS) {
      if (usedPercent < threshold) {
        continue;
      }

      if (threshold === 100) {
        const overflowDollars =
          Math.max(0, projectedUsedPoints - snapshot.monthlyLimitPoints) /
          POINTS_PER_DOLLAR;
        const guardrailRemaining = snapshot.extraUsageMonthlyRemainingAtStart;
        const guardrailAllowsOverflow =
          guardrailRemaining === undefined ||
          overflowDollars <= guardrailRemaining;
        const balanceAllowsOverflow =
          snapshot.extraUsageAutoReload ||
          snapshot.extraUsageBalanceAtStart >= overflowDollars;
        const hasExtraCushion =
          guardrailAllowsOverflow && balanceAllowsOverflow;

        if (hasExtraCushion) {
          if (threshold <= this.highestThresholdEmitted) {
            continue;
          }
          this.highestThresholdEmitted = threshold;
          writeRateLimitWarning(this.writer, {
            warningType: "extra-usage-active",
            bucketType: "monthly",
            resetTime: snapshot.monthlyResetTime.toISOString(),
            subscription: this.subscription,
            capReason: "extra_usage_active",
            midStream: true,
          });
        } else {
          const capReason: LimitCapReason =
            this.subscription === "free"
              ? "free_monthly_exhausted"
              : !guardrailAllowsOverflow
                ? "extra_usage_cap"
                : "monthly_exhausted";
          this.emit({
            usedPercent: 100,
            projectedUsedPoints: snapshot.monthlyLimitPoints,
            cutOff: true,
            capReason,
          });
          decision = "abort";
        }
      } else {
        if (threshold <= this.highestThresholdEmitted) {
          continue;
        }
        this.highestThresholdEmitted = threshold;
        this.emit({ usedPercent, projectedUsedPoints });
      }
    }

    return decision;
  }

  private emit(args: {
    usedPercent: number;
    projectedUsedPoints: number;
    cutOff?: boolean;
    capReason?: LimitCapReason;
  }): void {
    const ctx: TokenBucketEmitContext = {
      usedPercent: args.usedPercent,
      projectedUsedPoints: args.projectedUsedPoints,
      monthlyLimitPoints: this.snapshot.monthlyLimitPoints,
      resetTime: this.snapshot.monthlyResetTime,
      subscription: this.subscription,
      midStream: true,
      cutOff: args.cutOff,
      capReason: args.capReason,
    };
    emitTokenBucketThresholdWarning(this.writer, ctx);
  }
}
