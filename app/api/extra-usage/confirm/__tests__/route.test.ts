import { GET } from "../route";
import { stripe } from "@/app/api/stripe";
import { getConvexClient } from "@/lib/db/convex-client";
import { logExtraUsagePurchase } from "@/lib/billing/extra-usage-purchase-logging";
import { phLogger } from "@/lib/posthog/server";

jest.mock("next/server", () => ({
  after: jest.fn(),
  NextResponse: {
    redirect: (url: string | URL, init: { status: number }) => ({
      status: init.status,
      headers: new Headers({ location: String(url) }),
    }),
  },
}));
jest.mock("@/app/api/stripe", () => ({
  stripe: { checkout: { sessions: { retrieve: jest.fn() } } },
}));
jest.mock("@/lib/db/convex-client", () => ({ getConvexClient: jest.fn() }));
jest.mock("@/lib/posthog/server", () => ({
  phLogger: { event: jest.fn(), flush: jest.fn() },
}));
jest.mock("@/lib/billing/extra-usage-purchase-logging", () => ({
  logExtraUsagePurchase: jest.fn(),
}));

const mutation = jest.fn();
const session = {
  id: "cs_bundle",
  payment_status: "paid",
  currency: "usd",
  amount_total: 20000,
  metadata: {
    type: "extra_usage_purchase",
    userId: "user_fixture",
    returnPath: "/c/fixture",
    bundleId: "usage-250-v1",
    amountDollars: "250",
    paidAmountDollars: "200",
  },
};
const request = () =>
  ({
    nextUrl: new URL(
      "https://preview.example/api/extra-usage/confirm?session_id=cs_bundle",
    ),
    headers: new Headers(),
  }) as never;

beforeEach(() => {
  jest.clearAllMocks();
  mutation.mockResolvedValue({ alreadyProcessed: false });
  (getConvexClient as jest.Mock).mockReturnValue({ mutation });
});

it.each([
  { ...session, amount_total: 1 },
  { ...session, metadata: { ...session.metadata, amountDollars: "invalid" } },
])(
  "rejects invalid paid metadata without claiming purchase success",
  async (invalid) => {
    (stripe.checkout.sessions.retrieve as jest.Mock).mockResolvedValue(invalid);
    const response = await GET(request());
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://preview.example/c/fixture",
    );
    expect(mutation).not.toHaveBeenCalled();
    expect(logExtraUsagePurchase).toHaveBeenCalledWith(
      "error",
      "extra_usage_purchase_invalid_metadata",
      expect.objectContaining({ stripeCheckoutSessionId: "cs_bundle" }),
    );
  },
);

it("forwards face value and cash separately and returns to the original chat", async () => {
  (stripe.checkout.sessions.retrieve as jest.Mock).mockResolvedValue(session);
  const response = await GET(request());
  expect(mutation).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({
      amountDollars: 250,
      paidAmountDollars: 200,
      bundleId: "usage-250-v1",
      idempotencyKey: "cs_cs_bundle",
    }),
  );
  const target = new URL(response.headers.get("location")!);
  expect(target.pathname).toBe("/c/fixture");
  expect(target.searchParams.get("extra-usage-purchased")).toBe("true");
  expect(target.searchParams.get("amount")).toBe("250");
});

describe("purchase success analytics", () => {
  const reservedSession = {
    ...session,
    metadata: {
      ...session.metadata,
      bundleReservationId: "reservation_fixture",
      bundleCapPeriod: "2026-11",
      bundleCapPolicyVersion: "bundle-cap-v1",
    },
  };

  it("reports the purchase once, from the route that granted the credit", async () => {
    (stripe.checkout.sessions.retrieve as jest.Mock).mockResolvedValue(
      reservedSession,
    );
    await GET(request());

    expect(mutation).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ bundleReservationId: "reservation_fixture" }),
    );
    expect(phLogger.event).toHaveBeenCalledTimes(1);
    expect(phLogger.event).toHaveBeenCalledWith(
      "add_credit_checkout_succeeded",
      expect.objectContaining({
        amount_dollars: 200,
        credit_amount_dollars: 250,
        discount_dollars: 50,
        bundle_cap_period: "2026-11",
        bundle_cap_policy_version: "bundle-cap-v1",
        fulfillment_route: "confirm",
        stripe_checkout_session_id: "cs_bundle",
      }),
    );
  });

  it("does not report again when the webhook already credited the session", async () => {
    (stripe.checkout.sessions.retrieve as jest.Mock).mockResolvedValue(
      reservedSession,
    );
    mutation.mockResolvedValue({ alreadyProcessed: true });
    const response = await GET(request());

    expect(phLogger.event).not.toHaveBeenCalled();
    expect(
      new URL(response.headers.get("location")!).searchParams.get(
        "extra-usage-purchased",
      ),
    ).toBe("true");
  });
});
