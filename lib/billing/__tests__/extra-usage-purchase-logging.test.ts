import { logExtraUsagePurchase } from "../extra-usage-purchase-logging";

describe("extra usage purchase logging", () => {
  beforeEach(() => {
    jest.spyOn(console, "info").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("logs queryable purchase context without raw secrets", () => {
    logExtraUsagePurchase("error", "extra_usage_purchase_credit_failed", {
      route: "/api/extra-usage/confirm",
      requestHeaders: new Headers({ "x-vercel-id": "iad1::abc123" }),
      userId: "user_123",
      amountDollars: 50,
      stripeCheckoutSessionId: "cs_test",
      stripePaymentIntentId: "pi_test",
      stripeInvoiceId: "in_test",
      paymentStatus: "paid",
      result: "failed",
      error: new Error("serviceKey: secret-value\nsecond line"),
    });

    expect(console.error).toHaveBeenCalledWith(
      "[Extra Usage Purchase]",
      expect.objectContaining({
        event: "extra_usage_purchase_credit_failed",
        level: "error",
        service: "hackerai-web",
        route: "/api/extra-usage/confirm",
        request_id: "iad1::abc123",
        user_id: "user_123",
        amount_dollars: 50,
        stripe_checkout_session_id: "cs_test",
        stripe_payment_intent_id: "pi_test",
        stripe_invoice_id: "in_test",
        payment_status: "paid",
        result: "failed",
        error_name: "Error",
        error_message: "serviceKey: [redacted]",
      }),
    );

    const serializedFields = JSON.stringify(
      (console.error as jest.Mock).mock.calls[0][1],
    );
    expect(serializedFields).not.toContain("secret-value");
    expect(serializedFields).not.toContain("second line");
  });

  it("uses info logs for handled route decisions", () => {
    logExtraUsagePurchase("info", "extra_usage_purchase_credit_skipped", {
      route: "/api/extra-usage/webhook",
      requestHeaders: new Headers(),
      userId: "user_123",
      stripeCheckoutSessionId: "cs_test",
      result: "already_processed",
    });

    expect(console.info).toHaveBeenCalledWith(
      "[Extra Usage Purchase]",
      expect.objectContaining({
        event: "extra_usage_purchase_credit_skipped",
        level: "info",
        route: "/api/extra-usage/webhook",
        result: "already_processed",
      }),
    );
  });
});
