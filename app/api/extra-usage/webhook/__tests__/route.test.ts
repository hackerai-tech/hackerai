import { getFunctionName } from "convex/server";
import { POST } from "../route";
import { stripe } from "@/app/api/stripe";
import { getConvexClient } from "@/lib/db/convex-client";
import { phLogger } from "@/lib/posthog/server";

jest.mock("next/server", () => ({
  after: jest.fn(),
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      body,
    }),
  },
}));
jest.mock("@/app/api/stripe", () => ({
  stripe: { webhooks: { constructEvent: jest.fn() } },
}));
jest.mock("@/lib/db/convex-client", () => ({ getConvexClient: jest.fn() }));
jest.mock("@/lib/posthog/server", () => ({
  phLogger: { event: jest.fn(), flush: jest.fn() },
}));
jest.mock("@/lib/billing/extra-usage-purchase-logging", () => ({
  logExtraUsagePurchase: jest.fn(),
}));
jest.mock("@/lib/billing/stripe-webhook-logging", () => ({
  logStripeWebhookMissingSignature: jest.fn(),
  logStripeWebhookSignatureVerificationFailed: jest.fn(),
}));

const mutation = jest.fn();
const originalSecret = process.env.STRIPE_EXTRA_USAGE_WEBHOOK_SECRET;

const bundleSession = {
  id: "cs_bundle",
  payment_status: "paid",
  currency: "usd",
  amount_total: 70000,
  metadata: {
    type: "extra_usage_purchase",
    userId: "user_fixture",
    bundleId: "usage-1000-v1",
    amountDollars: "1000",
    paidAmountDollars: "700",
    bundleReservationId: "reservation_fixture",
    bundleCapPeriod: "2026-11",
    bundleCapPolicyVersion: "bundle-cap-v1",
  },
};

const deliver = (type: string, object: unknown) => {
  (stripe.webhooks.constructEvent as jest.Mock).mockReturnValue({
    id: "evt_fixture",
    type,
    data: { object },
  });
  return POST({
    text: async () => "{}",
    headers: new Headers({ "stripe-signature": "sig_fixture" }),
  } as never);
};

const calledFunctions = () =>
  mutation.mock.calls.map(([reference]) => getFunctionName(reference));

beforeAll(() => {
  process.env.STRIPE_EXTRA_USAGE_WEBHOOK_SECRET = "whsec_fixture";
});
afterAll(() => {
  if (originalSecret === undefined)
    delete process.env.STRIPE_EXTRA_USAGE_WEBHOOK_SECRET;
  else process.env.STRIPE_EXTRA_USAGE_WEBHOOK_SECRET = originalSecret;
});
beforeEach(() => {
  jest.clearAllMocks();
  mutation.mockResolvedValue({ alreadyProcessed: false, released: true });
  (getConvexClient as jest.Mock).mockReturnValue({ mutation });
});

it("releases the bundle hold when Stripe reports the session expired", async () => {
  const response = await deliver("checkout.session.expired", {
    ...bundleSession,
    status: "expired",
    payment_status: "unpaid",
  });

  expect(response.status).toBe(200);
  expect(calledFunctions()).toEqual([
    "extraUsageBundles:releaseBundleSessionFromStripe",
  ]);
  expect(mutation).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      userId: "user_fixture",
      stripeCheckoutSessionId: "cs_bundle",
      bundleReservationId: "reservation_fixture",
      reason: "stripe_session_expired",
    }),
  );
});

it("ignores expiry of a full-price top-up", async () => {
  const response = await deliver("checkout.session.expired", {
    id: "cs_topup",
    metadata: {
      type: "extra_usage_purchase",
      userId: "user_fixture",
      amountDollars: "75",
    },
  });

  expect(response.status).toBe(200);
  expect(mutation).not.toHaveBeenCalled();
});

it("asks Stripe to retry when the expiry release cannot be recorded", async () => {
  mutation.mockRejectedValueOnce(new Error("Convex unavailable"));
  const response = await deliver("checkout.session.expired", bundleSession);
  expect(response.status).toBe(500);
});

it("records an async payment failure and releases its bundle hold", async () => {
  const response = await deliver("checkout.session.async_payment_failed", {
    ...bundleSession,
    payment_status: "unpaid",
  });

  expect(response.status).toBe(200);
  expect(calledFunctions()).toEqual([
    "extraUsage:recordPurchaseFailed",
    "extraUsageBundles:releaseBundleSessionFromStripe",
  ]);
  expect(mutation).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({ reason: "stripe_async_payment_failed" }),
  );
});

it("reports a paid bundle once and forwards its reservation for consumption", async () => {
  await deliver("checkout.session.completed", bundleSession);

  expect(mutation).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({
      bundleId: "usage-1000-v1",
      bundleReservationId: "reservation_fixture",
      idempotencyKey: "cs_cs_bundle",
    }),
  );
  expect(phLogger.event).toHaveBeenCalledTimes(1);
  expect(phLogger.event).toHaveBeenCalledWith(
    "add_credit_checkout_succeeded",
    expect.objectContaining({
      amount_dollars: 700,
      credit_amount_dollars: 1000,
      discount_dollars: 300,
      bundle_cap_period: "2026-11",
      fulfillment_route: "webhook",
    }),
  );

  jest.clearAllMocks();
  mutation.mockResolvedValue({ alreadyProcessed: true });
  const duplicate = await deliver("checkout.session.completed", bundleSession);
  expect(duplicate.status).toBe(200);
  expect(phLogger.event).not.toHaveBeenCalled();
});
