/**
 * User-facing billing error messages shared by server actions and API routes.
 * Kept free of Next.js imports so server actions and background jobs can use
 * them without pulling in the route runtime.
 */
export const BILLING_ERRORS = {
  subscriptionChangeInProgress:
    "Another subscription change is still processing. Try again shortly, or contact support if this continues.",
  subscriptionChangeUnavailable:
    "Subscription changes are temporarily unavailable. Please try again shortly.",
  accountSuspended:
    "Billing is disabled while this account has an active payment dispute or fraud hold. Contact support before making another payment.",
  retentionOfferUnavailable:
    "This offer is not available for your subscription",
  invalidPauseDuration: "Please choose how long to pause your plan",
  noPausedSubscription: "No paused subscription found",
  resumePaymentFailed:
    "We couldn't charge your saved payment method. Update it and try again.",
  resumeNoPaymentMethod:
    "No saved payment method found. Choose a plan to subscribe again.",
} as const;
