const EXPECTED_BILLING_CONTEXT_ERROR_MESSAGES = new Set([
  "User not authenticated",
  "No organization found",
  "User is not a member of this organization",
  "Only admins or owners can manage billing",
  "No billing account found for this organization",
]);

const EXPECTED_SUBSCRIPTION_LOOKUP_ERROR_MESSAGES = new Set([
  "No active subscription found",
]);

function hasExpectedErrorMessage(
  error: unknown,
  messages: Set<string>,
): boolean {
  return error instanceof Error && messages.has(error.message);
}

export function isExpectedBillingContextError(error: unknown): boolean {
  return hasExpectedErrorMessage(
    error,
    EXPECTED_BILLING_CONTEXT_ERROR_MESSAGES,
  );
}

export function isExpectedSubscriptionLookupError(error: unknown): boolean {
  return hasExpectedErrorMessage(
    error,
    EXPECTED_SUBSCRIPTION_LOOKUP_ERROR_MESSAGES,
  );
}
