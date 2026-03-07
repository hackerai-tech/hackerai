import type { RateLimitInfo, SubscriptionTier } from "@/types";
import { refundUsage } from "./token-bucket";

/**
 * Tracks usage deductions and handles refunds on error.
 * Ensures refunds only happen once, even if multiple error handlers trigger.
 */
export class UsageRefundTracker {
  private amountDeducted = 0;
  private extraUsageAmountDeducted = 0;
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
   * Record deductions from rate limit check (amounts in dollars).
   */
  recordDeductions(rateLimitInfo: RateLimitInfo): void {
    this.amountDeducted = rateLimitInfo.amountDeducted ?? 0;
    this.extraUsageAmountDeducted = rateLimitInfo.extraUsageAmountDeducted ?? 0;
  }

  /**
   * Check if there are any deductions to refund.
   */
  hasDeductions(): boolean {
    return this.amountDeducted > 0 || this.extraUsageAmountDeducted > 0;
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
        this.amountDeducted,
        this.extraUsageAmountDeducted,
      );
      this.hasRefunded = true;
    } catch (error) {
      console.error("Failed to refund usage:", error);
      // Flag stays false, allowing retry on transient failures
    }
  }
}
