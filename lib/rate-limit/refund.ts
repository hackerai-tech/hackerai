import { randomUUID } from "node:crypto";
import type { RateLimitInfo, SubscriptionTier } from "@/types";
import { refundUsage, type UsageDeductionResult } from "./token-bucket";

export type UsageRefundOutcome = {
  status: "refunded" | "partial" | "failed" | "skipped";
  includedPointsRefunded: number;
  extraUsagePointsRefunded: number;
  includedPointsRemaining: number;
  extraUsagePointsRemaining: number;
};

/**
 * Tracks usage deductions and handles refunds on error.
 * Serializes concurrent refunds and keeps only unconfirmed amounts retryable.
 */
export class UsageRefundTracker {
  private pointsDeducted = 0;
  private extraUsagePointsDeducted = 0;
  private userId: string | undefined;
  private subscription: SubscriptionTier | undefined;
  private organizationId: string | undefined;
  private refundInFlight: Promise<UsageRefundOutcome> | undefined;
  private includedRefundId: string | undefined;

  /**
   * Set user context for refunds.
   */
  setUser(
    userId: string,
    subscription: SubscriptionTier,
    organizationId?: string,
  ): void {
    this.userId = userId;
    this.subscription = subscription;
    this.organizationId = organizationId;
  }

  /**
   * Record deductions from rate limit check.
   */
  recordDeductions(rateLimitInfo: RateLimitInfo): void {
    this.pointsDeducted = rateLimitInfo.pointsDeducted ?? 0;
    this.extraUsagePointsDeducted = rateLimitInfo.extraUsagePointsDeducted ?? 0;
  }

  /**
   * Add deductions performed after the initial rate-limit check.
   */
  addDeductions(
    deductions: Pick<
      UsageDeductionResult,
      "includedPointsDeducted" | "extraUsagePointsDeducted"
    >,
  ): void {
    this.pointsDeducted += deductions.includedPointsDeducted ?? 0;
    this.extraUsagePointsDeducted += deductions.extraUsagePointsDeducted ?? 0;
  }

  /**
   * Check if there are any deductions to refund.
   */
  hasDeductions(): boolean {
    return this.pointsDeducted > 0 || this.extraUsagePointsDeducted > 0;
  }

  /**
   * Refund all tracked deductions without duplicating confirmed refunds.
   * Call this from error handlers to restore credits on failure.
   */
  async refund(): Promise<void> {
    await this.refundWithResult();
  }

  /** Refund tracked deductions and report only amounts confirmed restored. */
  async refundWithResult(): Promise<UsageRefundOutcome> {
    if (this.refundInFlight) return this.refundInFlight;
    this.refundInFlight = this.performRefund().finally(() => {
      this.refundInFlight = undefined;
    });
    return this.refundInFlight;
  }

  private async performRefund(): Promise<UsageRefundOutcome> {
    const skipped = (): UsageRefundOutcome => ({
      status: "skipped",
      includedPointsRefunded: 0,
      extraUsagePointsRefunded: 0,
      includedPointsRemaining: this.pointsDeducted,
      extraUsagePointsRemaining: this.extraUsagePointsDeducted,
    });
    if (!this.hasDeductions()) return skipped();
    if (!this.userId || !this.subscription) {
      return skipped();
    }

    let result;
    try {
      const includedRefundId =
        this.pointsDeducted > 0
          ? (this.includedRefundId ??= randomUUID())
          : undefined;
      result = await refundUsage(
        this.userId,
        this.subscription,
        this.pointsDeducted,
        this.extraUsagePointsDeducted,
        this.organizationId,
        includedRefundId,
      );
    } catch (error) {
      console.error("Failed to refund usage:", error);
      return {
        status: "failed",
        includedPointsRefunded: 0,
        extraUsagePointsRefunded: 0,
        includedPointsRemaining: this.pointsDeducted,
        extraUsagePointsRemaining: this.extraUsagePointsDeducted,
      };
    }
    this.pointsDeducted = Math.max(
      0,
      this.pointsDeducted - result.includedPointsRefunded,
    );
    if (this.pointsDeducted === 0) this.includedRefundId = undefined;
    this.extraUsagePointsDeducted = Math.max(
      0,
      this.extraUsagePointsDeducted - result.extraUsagePointsRefunded,
    );

    const refundedAny =
      result.includedPointsRefunded > 0 || result.extraUsagePointsRefunded > 0;
    const hasRemaining = this.hasDeductions();
    return {
      status: hasRemaining ? (refundedAny ? "partial" : "failed") : "refunded",
      includedPointsRefunded: result.includedPointsRefunded,
      extraUsagePointsRefunded: result.extraUsagePointsRefunded,
      includedPointsRemaining: this.pointsDeducted,
      extraUsagePointsRemaining: this.extraUsagePointsDeducted,
    };
  }
}
