import { NextResponse } from "next/server";

const BILLING_ERROR_STATUSES = new Map<string, number>([
  ["User not authenticated", 401],
  ["No organization found", 404],
  ["User is not a member of this organization", 403],
  ["Only admins or owners can manage billing", 403],
  ["No billing account found for this organization", 404],
  ["No active subscription found", 404],
  ["Please select the main cancellation reason", 400],
  ["Please write a cancellation reason before continuing", 400],
]);

export function billingRouteErrorResponse(error: unknown) {
  const message =
    error instanceof Error ? error.message : "Billing request failed";
  const status = BILLING_ERROR_STATUSES.get(message) ?? 500;

  return NextResponse.json({ error: message }, { status });
}
