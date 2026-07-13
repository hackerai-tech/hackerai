import {
  isTerminalPaymentMethodDetachError,
  isTerminalStripeResourceError,
} from "@/lib/billing/stripe-terminal-errors";

describe("Stripe terminal error classification", () => {
  it("treats missing resources as an idempotent terminal state", () => {
    const error = {
      type: "StripeInvalidRequestError",
      code: "resource_missing",
      message: "No such payment method",
    };

    expect(isTerminalStripeResourceError(error)).toBe(true);
    expect(isTerminalPaymentMethodDetachError(error)).toBe(true);
  });

  it("treats an already-detached payment method as terminal", () => {
    const error = {
      type: "StripeInvalidRequestError",
      message:
        "The payment method pm_123 is not attached to a customer so detachment is impossible.",
    };

    expect(isTerminalPaymentMethodDetachError(error)).toBe(true);
  });

  it("keeps other Stripe failures retriable", () => {
    const invalidRequest = {
      type: "StripeInvalidRequestError",
      message: "Payment method belongs to another customer",
    };
    const apiError = {
      type: "StripeAPIError",
      message: "Stripe is unavailable",
    };

    expect(isTerminalPaymentMethodDetachError(invalidRequest)).toBe(false);
    expect(isTerminalPaymentMethodDetachError(apiError)).toBe(false);
  });
});
