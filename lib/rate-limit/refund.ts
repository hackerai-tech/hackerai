import type { RateLimitInfo, SubscriptionTier } from "@/types";
import { refundUsage } from "./token-bucket";

/**
 * Tracks usage deductions and handles refunds on error.
 * Ensures refunds only happen once, even if multiple error handlers trigger.
 */
export class UsageRefundTracker {
  private pointsDeducted = 0;
  private extraUsagePointsDeducted = 0;
  private userId: string | undefined;
  private subscription: SubscriptionTier | undefined;
  private hasRefunded = false;

  /**
   * Set user context for refunds.
   */
  setUser(userId: string, subscription: SubscriptionTier): void {
    this.userId = userId;
    this.subscription = subscription;
  }

  /**
   * Record deductions from rate limit check.
   */
  recordDeductions(rateLimitInfo: RateLimitInfo): void {
    this.pointsDeducted = rateLimitInfo.pointsDeducted ?? 0;
    this.extraUsagePointsDeducted = rateLimitInfo.extraUsagePointsDeducted ?? 0;
  }

  /**
   * Check if there are any deductions to refund.
   */
  hasDeductions(): boolean {
    return this.pointsDeducted > 0 || this.extraUsagePointsDeducted > 0;
  }

  /**
   * Refund all deducted credits (idempotent - only refunds once).
   * Call this from error handlers to restore credits on failure.
   */
  async refund(): Promise<void> {
    if (this.hasRefunded || !this.hasDeductions()) {
      return;
    }

    if (!this.userId || !this.subscription) {
      return;
    }

    try {
      await refundUsage(
        this.userId,
        this.subscription,
        this.pointsDeducted,
        this.extraUsagePointsDeducted,
      );
      this.hasRefunded = true;
    } catch (error) {
      console.error("Failed to refund usage:", error);
      // Flag stays false, allowing retry on transient failures
    }
  }
}
