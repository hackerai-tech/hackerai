/**
 * User-facing billing error messages shared by server actions and API routes.
 * Kept free of Next.js imports so server actions and background jobs can use
 * them without pulling in the route runtime.
 */
export const BILLING_ERRORS = {
  retentionOfferUnavailable:
    "This offer is not available for your subscription",
  invalidPauseDuration: "Please choose how long to pause your plan",
  noPausedSubscription: "No paused subscription found",
  resumePaymentFailed:
    "We couldn't charge your saved payment method. Update it and try again.",
  resumeNoPaymentMethod:
    "No saved payment method found. Choose a plan to subscribe again.",
} as const;
