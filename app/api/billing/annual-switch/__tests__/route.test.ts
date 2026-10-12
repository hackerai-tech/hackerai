import { POST } from "../route";
import type { NextRequest } from "next/server";
jest.mock("next/server", () => ({
  after: (fn: () => void) => fn(),
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));
jest.mock("@/lib/posthog/server", () => ({
  phLogger: { event: jest.fn(), flush: jest.fn() },
}));
const mockContext = jest.fn();
const mockGuard = jest.fn();
const mockCustomer = jest.fn();
const mockSubscriptions = jest.fn();
const mockPrices = jest.fn();
const mockPreview = jest.fn();
const mockUpdate = jest.fn();
const mockInvoice = jest.fn();
jest.mock("@/lib/actions/billing-context", () => ({
  getBillingActionContext: (...args: unknown[]) => mockContext(...args),
}));
jest.mock("@/lib/suspensions", () => ({
  assertUserCanStartBillingTransaction: (...args: unknown[]) =>
    mockGuard(...args),
}));
jest.mock("@/app/api/stripe", () => ({
  stripe: {
    customers: { retrieve: (...args: unknown[]) => mockCustomer(...args) },
    subscriptions: {
      list: (...args: unknown[]) => mockSubscriptions(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
    },
    prices: { list: (...args: unknown[]) => mockPrices(...args) },
    invoices: {
      createPreview: (...args: unknown[]) => mockPreview(...args),
      retrieve: (...args: unknown[]) => mockInvoice(...args),
    },
  },
}));
const now = 1791840000;
const monthly = {
  id: "price_month",
  lookup_key: "pro-monthly-plan",
  currency: "usd",
  recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
};
const yearly = {
  id: "price_year",
  lookup_key: "pro-yearly-plan",
  active: true,
  currency: "usd",
  type: "recurring",
  billing_scheme: "per_unit",
  unit_amount: 28800,
  recurring: { interval: "year", interval_count: 1, usage_type: "licensed" },
};
const active = () => ({
  id: "sub_one",
  status: "active",
  collection_method: "charge_automatically",
  latest_invoice: { id: "in_paid", status: "paid" },
  items: {
    data: [
      {
        id: "si_one",
        quantity: 1,
        price: monthly,
        current_period_start: now - 100,
        current_period_end: now + 100,
      },
    ],
  },
});
const request = (extra = {}) =>
  ({
    json: async () => ({
      plan: "pro-yearly-plan",
      checkoutAttemptId: "ca_12345678-1234-1234-1234-123456789012",
      ...extra,
    }),
  }) as NextRequest;
beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Date, "now").mockReturnValue(now * 1000);
  mockContext.mockResolvedValue({
    user: { id: "user_one" },
    stripeCustomerId: "cus_one",
    organizationId: "org_one",
  });
  mockGuard.mockResolvedValue(undefined);
  mockCustomer.mockResolvedValue({ id: "cus_one", metadata: {} });
  mockSubscriptions.mockResolvedValue({ data: [active()] });
  mockPrices.mockResolvedValue({ data: [yearly] });
  mockPreview.mockResolvedValue({
    amount_due: 27350,
    currency: "usd",
    lines: { data: [{ amount: 28800 }, { amount: -1450 }] },
  });
  mockUpdate.mockResolvedValue({
    latest_invoice: "in_new",
    items: { data: [{ price: yearly }] },
  });
  mockInvoice.mockResolvedValue({ status: "paid" });
});
afterEach(() => jest.restoreAllMocks());
it("quotes annual total and unused monthly credit without a write", async () => {
  const response = await POST(request());
  const data = await response.json();
  expect(response.status).toBe(200);
  expect(data).toMatchObject({
    annualAmount: 288,
    totalDue: 273.5,
    proratedCredit: 14.5,
    billingIntervalChanged: true,
  });
  expect(mockUpdate).not.toHaveBeenCalled();
});
it.each([
  { status: "past_due" },
  { status: "unpaid" },
  { status: "trialing" },
  { cancel_at_period_end: true },
  { cancel_at: now + 100 },
  { schedule: "sched_one" },
  { pending_update: {} },
  { pause_collection: {} },
  { latest_invoice: { status: "open" } },
  { items: { data: [] } },
  { collection_method: "send_invoice" },
])("rejects conflicting subscription state %j", async (change) => {
  mockSubscriptions.mockResolvedValue({ data: [{ ...active(), ...change }] });
  expect((await POST(request())).status).toBe(409);
  expect(mockUpdate).not.toHaveBeenCalled();
});
it.each([{ data: [active(), active()] }, { data: [active()], has_more: true }])(
  "rejects ambiguous subscriptions",
  async (result) => {
    mockSubscriptions.mockResolvedValue(result);
    expect((await POST(request())).status).toBe(409);
  },
);
it("rejects another tier and a stale price before charging", async () => {
  expect((await POST(request({ plan: "ultra-yearly-plan" }))).status).toBe(409);
  mockPrices.mockResolvedValue({ data: [{ ...yearly, unit_amount: 25200 }] });
  expect((await POST(request())).status).toBe(503);
  expect(mockUpdate).not.toHaveBeenCalled();
});
it("requires a fresh matching quote and uses its exact proration time", async () => {
  const { quote } = await (await POST(request())).json();
  expect((await POST(request({ confirm: true }))).status).toBe(409);
  expect(
    (await POST(request({ confirm: true, quote: { ...quote, amountDue: 1 } })))
      .status,
  ).toBe(409);
  expect(
    (
      await POST(
        request({
          confirm: true,
          quote: { ...quote, prorationDate: now - 601 },
        }),
      )
    ).status,
  ).toBe(409);
  expect(mockUpdate).not.toHaveBeenCalled();
  const result = await (await POST(request({ confirm: true, quote }))).json();
  expect(result.success).toBe(true);
  expect(mockUpdate).toHaveBeenCalledWith(
    "sub_one",
    expect.objectContaining({
      payment_behavior: "pending_if_incomplete",
      proration_date: now,
      items: [{ id: "si_one", price: "price_year", quantity: 1 }],
    }),
    { idempotencyKey: expect.stringContaining("annual-switch:sub_one:ca_") },
  );
});
it("returns hosted authentication/payment without reporting success", async () => {
  const { quote } = await (await POST(request())).json();
  mockUpdate.mockResolvedValue({
    latest_invoice: "in_new",
    pending_update: {},
    items: { data: [{ price: monthly }] },
  });
  mockInvoice.mockResolvedValue({
    status: "open",
    hosted_invoice_url: "https://invoice.stripe.com/i/test",
  });
  expect(await (await POST(request({ confirm: true, quote }))).json()).toEqual({
    requiresPayment: true,
    invoiceUrl: "https://invoice.stripe.com/i/test",
  });
});
it("never writes when Stripe cannot quote", async () => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  mockPreview.mockRejectedValue(new Error("Preview unavailable"));
  expect(
    (await POST(request({ confirm: true, quote: { prorationDate: now } })))
      .status,
  ).toBe(500);
  expect(mockUpdate).not.toHaveBeenCalled();
});
it("preserves authorization and suspension failures", async () => {
  mockContext.mockRejectedValueOnce(
    new Error("Only admins or owners can manage billing"),
  );
  expect((await POST(request())).status).toBe(403);
  expect(mockSubscriptions).not.toHaveBeenCalled();
});
