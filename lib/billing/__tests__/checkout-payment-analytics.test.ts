import type Stripe from "stripe";
import { captureCheckoutPaymentAnalytics } from "../checkout-payment-analytics";
import { phLogger } from "@/lib/posthog/server";

jest.mock("@/lib/posthog/server", () => ({ phLogger: { event: jest.fn() } }));

const session = {
  id: "cs_checkout",
  mode: "subscription",
  customer: "cus_checkout",
  livemode: false,
  created: 1000,
  expires_at: 87400,
  metadata: {
    checkoutType: "new_subscription",
    userId: "user_123",
    checkoutSource: "ask_limit",
    checkoutAttemptId: "attempt_123",
    requestedPlan: "pro-monthly-plan",
  },
} as unknown as Stripe.Checkout.Session;
const intent = {
  id: "pi_checkout",
  customer: "cus_checkout",
  created: 1010,
  livemode: false,
  status: "requires_payment_method",
  amount: 2500,
  currency: "usd",
  latest_charge: "ch_failed",
  last_payment_error: {
    code: "card_declined",
    decline_code: "generic_decline",
    message: "PRIVATE MESSAGE",
    payment_method: { billing_details: { email: "PRIVATE EMAIL" } },
  },
} as unknown as Stripe.PaymentIntent;
const event = (
  type = "payment_intent.payment_failed",
  object: unknown = intent,
  id = "evt_failed",
) =>
  ({
    id,
    type,
    created: 1020,
    livemode: false,
    data: { object },
  }) as Stripe.Event;

describe("initial subscription Checkout analytics", () => {
  const list = jest.fn();
  const retrieveCharge = jest.fn();
  const retrieveIntent = jest.fn();
  const stripe = {
    checkout: { sessions: { list } },
    charges: { retrieve: retrieveCharge },
    paymentIntents: { retrieve: retrieveIntent },
  } as unknown as Stripe;
  beforeEach(() => {
    jest.clearAllMocks();
    list.mockResolvedValue({ data: [session], has_more: false });
    retrieveCharge.mockResolvedValue({
      id: "ch_failed",
      failure_code: "card_declined",
      outcome: { type: "blocked", reason: "highest_risk_level" },
      billing_details: { email: "PRIVATE EMAIL" },
    });
  });

  it("links a pre-invoice failure exactly, classifies risk blocks, and excludes payment details", async () => {
    await captureCheckoutPaymentAnalytics(stripe, event());
    expect(list).toHaveBeenCalledWith({
      payment_intent: "pi_checkout",
      limit: 2,
    });
    expect(phLogger.event).toHaveBeenCalledWith(
      "checkout_payment_failed",
      expect.objectContaining({
        userId: "user_123",
        stripe_checkout_session_id: "cs_checkout",
        stripe_payment_intent_id: "pi_checkout",
        stripe_event_created_at: "1970-01-01T00:17:00.000Z",
        billing_failure_group: "stripe_risk_block",
        amount_minor_units: 2500,
      }),
    );
    expect(
      JSON.stringify((phLogger.event as jest.Mock).mock.calls),
    ).not.toContain("PRIVATE");
    expect(retrieveIntent).not.toHaveBeenCalled();
  });

  it("gives retries a stable UUID even if session reuse changes attempt metadata", async () => {
    await captureCheckoutPaymentAnalytics(stripe, event());
    const first = (phLogger.event as jest.Mock).mock.calls[0][1];
    list.mockResolvedValue({
      data: [
        {
          ...session,
          metadata: {
            ...session.metadata,
            checkoutAttemptId: "attempt_reopened",
          },
        },
      ],
      has_more: false,
    });
    await captureCheckoutPaymentAnalytics(stripe, event());
    const second = (phLogger.event as jest.Mock).mock.calls[1][1];
    expect(second.eventUuid).toBe(first.eventUuid);
    expect(second.$insert_id).toBe(first.$insert_id);
    expect(second.stripe_checkout_session_id).toBe(
      first.stripe_checkout_session_id,
    );
  });

  it("preserves a delayed failed attempt after a later success without emitting paid conversion", async () => {
    await captureCheckoutPaymentAnalytics(
      stripe,
      event(
        "payment_intent.succeeded",
        {
          ...intent,
          status: "succeeded",
          latest_charge: null,
          last_payment_error: null,
        },
        "evt_success",
      ),
    );
    await captureCheckoutPaymentAnalytics(stripe, event());
    expect(
      (phLogger.event as jest.Mock).mock.calls.map(([name]) => name),
    ).toEqual(["checkout_payment_succeeded", "checkout_payment_failed"]);
    expect(
      (phLogger.event as jest.Mock).mock.calls[0][1].billing_failure_group,
    ).toBeUndefined();
    expect(retrieveIntent).not.toHaveBeenCalled();
    expect(retrieveCharge).toHaveBeenCalledWith("ch_failed");
  });

  it.each(["payment_intent.requires_action", "payment_intent.canceled"])(
    "captures %s without inventing a failure reason",
    async (type) => {
      await captureCheckoutPaymentAnalytics(
        stripe,
        event(type, {
          ...intent,
          latest_charge: null,
          last_payment_error: null,
        }),
      );
      expect(phLogger.event).toHaveBeenCalledTimes(1);
      expect(
        (phLogger.event as jest.Mock).mock.calls[0][1].billing_failure_group,
      ).toBeUndefined();
    },
  );

  it("captures expiration without claiming the customer did not attempt payment", async () => {
    await captureCheckoutPaymentAnalytics(
      stripe,
      event("checkout.session.expired", session),
    );
    expect(phLogger.event).toHaveBeenCalledWith(
      "checkout_expired",
      expect.objectContaining({ stripe_checkout_session_id: "cs_checkout" }),
    );
    expect(list).not.toHaveBeenCalled();
    expect(retrieveCharge).not.toHaveBeenCalled();
  });

  it.each([
    { data: [], has_more: false },
    { data: [session, session], has_more: false },
    { data: [session], has_more: true },
    { data: [{ ...session, mode: "payment" }], has_more: false },
    {
      data: [
        {
          ...session,
          metadata: { ...session.metadata, checkoutType: "extra_usage" },
        },
      ],
      has_more: false,
    },
    {
      data: [{ ...session, metadata: { userId: "user_123" } }],
      has_more: false,
    },
    { data: [{ ...session, customer: "cus_other" }], has_more: false },
    { data: [{ ...session, livemode: true }], has_more: false },
    { data: [{ ...session, created: 2000 }], has_more: false },
    { data: [{ ...session, expires_at: 1005 }], has_more: false },
  ])(
    "ignores unrelated, renewal, legacy, or ambiguous session linkage %#",
    async (result) => {
      list.mockResolvedValue(result);
      await captureCheckoutPaymentAnalytics(stripe, event());
      expect(phLogger.event).not.toHaveBeenCalled();
      expect(retrieveCharge).not.toHaveBeenCalled();
    },
  );

  it("propagates transient lookups so the webhook can request a Stripe retry", async () => {
    list.mockRejectedValue(new Error("temporarily unavailable"));
    await expect(
      captureCheckoutPaymentAnalytics(stripe, event()),
    ).rejects.toThrow("temporarily unavailable");
    expect(phLogger.event).not.toHaveBeenCalled();
  });
});
