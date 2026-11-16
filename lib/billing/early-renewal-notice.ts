import { planLookupKeyToTier } from "@/lib/analytics/paid-funnel";
import type { SubscriptionCancellationStatus } from "@/lib/billing/api-types";

/** Server-evaluated PostHog flag. Missing or failed evaluation means off. */
export const EARLY_RENEWAL_NOTICE_FLAG = "early-renewal-payment-notice";

export type EarlyRenewalNoticeTier = "pro" | "pro-plus" | "ultra";

const PLAN_NAMES: Record<EarlyRenewalNoticeTier, string> = {
  pro: "Pro",
  "pro-plus": "Pro+",
  ultra: "Ultra",
};

export type EarlyRenewalNotice = {
  tier: EarlyRenewalNoticeTier;
  planName: string;
  invoiceId: string;
};

/**
 * Returns a notice only for a complete, authoritative personal renewal failure.
 * Anything partial or ambiguous returns null: a false payment claim is worse
 * than waiting for the existing blocked-chat recovery.
 */
export function getEarlyRenewalNotice(
  status: SubscriptionCancellationStatus | undefined,
): EarlyRenewalNotice | null {
  if (
    !status ||
    status.hasActiveSubscription !== true ||
    (status.subscriptionStatus !== "past_due" &&
      status.subscriptionStatus !== "unpaid") ||
    status.renewalPaymentRequired !== true ||
    status.renewalInvoicePayable !== true ||
    status.renewalInvoicePaid === true ||
    status.checkoutRequiresReview === true ||
    status.billingReviewUnavailable === true ||
    status.cancelAtPeriodEnd !== false ||
    status.pause ||
    typeof status.latestInvoiceId !== "string" ||
    !status.latestInvoiceId
  ) {
    return null;
  }
  // The plan comes from the live Stripe price, never the session token, so a
  // stale entitlement cannot claim the wrong plan. Team billing is excluded.
  const tier = planLookupKeyToTier(status.stripePriceLookupKey);
  if (tier !== "pro" && tier !== "pro-plus" && tier !== "ultra") return null;
  return {
    tier,
    planName: PLAN_NAMES[tier],
    invoiceId: status.latestInvoiceId,
  };
}
