const ALREADY_DETACHED_PAYMENT_METHOD_MESSAGE =
  "is not attached to a customer so detachment is impossible";

const getStripeErrorField = (error: unknown, field: string) =>
  error && typeof error === "object"
    ? (error as Record<string, unknown>)[field]
    : undefined;

const hasStripeErrorType = (error: unknown, expectedType?: string): boolean => {
  const type = getStripeErrorField(error, "type");
  return (
    typeof type === "string" &&
    (expectedType ? type === expectedType : type.startsWith("Stripe"))
  );
};

export const isTerminalStripeResourceError = (error: unknown): boolean =>
  hasStripeErrorType(error) &&
  getStripeErrorField(error, "code") === "resource_missing";

export const isTerminalPaymentMethodDetachError = (error: unknown): boolean =>
  isTerminalStripeResourceError(error) ||
  (hasStripeErrorType(error, "StripeInvalidRequestError") &&
    typeof getStripeErrorField(error, "message") === "string" &&
    (getStripeErrorField(error, "message") as string).includes(
      ALREADY_DETACHED_PAYMENT_METHOD_MESSAGE,
    ));
