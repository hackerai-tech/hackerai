import { NextResponse } from "next/server";

import { BILLING_ERRORS } from "@/lib/billing/billing-errors";

export { BILLING_ERRORS };

const BILLING_ERROR_STATUSES = new Map<string, number>([
  ["User not authenticated", 401],
  ["No organization found", 404],
  ["User is not a member of this organization", 403],
  ["Only admins or owners can manage billing", 403],
  ["No billing account found for this organization", 404],
  ["No active subscription found", 404],
  ["Please select the main cancellation reason", 400],
  ["Please select what best describes the issue", 400],
  ["Please write a cancellation reason before continuing", 400],
  [BILLING_ERRORS.retentionOfferUnavailable, 400],
  [BILLING_ERRORS.invalidPauseDuration, 400],
  [BILLING_ERRORS.noPausedSubscription, 404],
  [BILLING_ERRORS.resumePaymentFailed, 402],
  [BILLING_ERRORS.resumeNoPaymentMethod, 402],
]);

export function billingRouteErrorResponse(error: unknown) {
  const message =
    error instanceof Error ? error.message : "Billing request failed";
  const status = BILLING_ERROR_STATUSES.get(message) ?? 500;

  if (status === 500) {
    console.error("Unhandled billing route error", error);
  }

  return NextResponse.json({ error: message }, { status });
}
