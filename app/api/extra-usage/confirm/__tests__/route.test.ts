import { GET } from "../route";
import { stripe } from "@/app/api/stripe";
import { getConvexClient } from "@/lib/db/convex-client";
import { logExtraUsagePurchase } from "@/lib/billing/extra-usage-purchase-logging";

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
