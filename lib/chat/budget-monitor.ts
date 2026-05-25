import "server-only";

import type { UIMessageStreamWriter } from "ai";
import type {
  ExtraUsageConfig,
  RateLimitInfo,
  SubscriptionTier,
} from "@/types";
import { POINTS_PER_DOLLAR } from "@/lib/rate-limit";
import {
  emitTokenBucketThresholdWarning,
  type TokenBucketEmitContext,
} from "@/lib/api/chat-stream-helpers";
import { writeRateLimitWarning } from "@/lib/utils/stream-writer-utils";

// 50% is intentionally omitted: at the halfway mark there's no actionable
// signal for the user, so an in-product banner is noise. The ladder matches
// the codebase's pre-existing 80/95 warnings, plus 100% which drives the
// abort. (Anthropic's Console alerts include 50% but deliver it via email,
// not an in-product disruption — we don't have that channel.)
export const BUDGET_THRESHOLDS = [80, 95, 100] as const;

export interface BudgetSnapshot {
  monthlyLimitPoints: number;
  monthlyRemainingAtStart: number;
  monthlyResetTime: Date;
  extraUsageBalanceAtStart: number;
  extraUsageAutoReload: boolean;
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

  constructor(
    private readonly snapshot: BudgetSnapshot,
    private readonly writer: UIMessageStreamWriter,
    private readonly subscription: SubscriptionTier,
  ) {
    const startUsedPercent =
      ((snapshot.monthlyLimitPoints - snapshot.monthlyRemainingAtStart) /
        snapshot.monthlyLimitPoints) *
      100;
    this.highestThresholdEmitted =
      BUDGET_THRESHOLDS.filter((t) => startUsedPercent >= t).pop() ?? 0;
  }

  checkAfterStep(currentCostDollars: number): "continue" | "abort" {
    const { snapshot } = this;
    const usedSinceStartPoints = Math.ceil(
      currentCostDollars * POINTS_PER_DOLLAR,
    );
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
        const hasExtraCushion =
          snapshot.extraUsageAutoReload ||
          snapshot.extraUsageBalanceAtStart - overflowDollars > 0;

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
            midStream: true,
          });
        } else {
          this.emit({
            usedPercent: 100,
            projectedUsedPoints: snapshot.monthlyLimitPoints,
            cutOff: true,
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
  }): void {
    const ctx: TokenBucketEmitContext = {
      usedPercent: args.usedPercent,
      projectedUsedPoints: args.projectedUsedPoints,
      monthlyLimitPoints: this.snapshot.monthlyLimitPoints,
      resetTime: this.snapshot.monthlyResetTime,
      subscription: this.subscription,
      midStream: true,
      cutOff: args.cutOff,
    };
    emitTokenBucketThresholdWarning(this.writer, ctx);
  }
}
