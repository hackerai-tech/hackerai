/** Allowlisted diagnostics only: SDK messages can contain request arguments. */
export function influencerErrorSummary(error: unknown) {
  const knownNames = new Set([
    "Error",
    "TypeError",
    "ConvexError",
    "StripeError",
    "StripeAPIError",
    "StripeAuthenticationError",
    "StripeConnectionError",
    "StripeInvalidRequestError",
    "StripePermissionError",
    "StripeRateLimitError",
  ]);
  const value = error as {
    name?: unknown;
    statusCode?: unknown;
    requestId?: unknown;
  } | null;
  const name =
    typeof value?.name === "string" && knownNames.has(value.name)
      ? value.name
      : "UnknownError";
  const status =
    typeof value?.statusCode === "number" &&
    Number.isInteger(value.statusCode) &&
    value.statusCode >= 400 &&
    value.statusCode <= 599
      ? value.statusCode
      : undefined;
  const requestId =
    typeof value?.requestId === "string" &&
    /^req_[a-zA-Z0-9]{1,100}$/.test(value.requestId)
      ? value.requestId
      : undefined;
  return {
    name,
    ...(status ? { status } : {}),
    ...(requestId ? { requestId } : {}),
  };
}
