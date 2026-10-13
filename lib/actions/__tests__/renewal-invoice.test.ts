import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockContext = jest.fn();
const mockAssertAllowed = jest.fn();
const mockList = jest.fn();
const mockRetrieve = jest.fn();
jest.mock("@/app/api/stripe", () => ({
  stripe: {
    subscriptions: { list: mockList },
    invoices: { retrieve: mockRetrieve },
  },
}));
jest.mock("@/lib/actions/billing-context", () => ({
  getBillingActionContext: mockContext,
}));
jest.mock("@/lib/suspensions", () => ({
  assertUserCanStartBillingTransaction: mockAssertAllowed,
}));

const subscription = {
  id: "sub_current",
  customer: "cus_current",
  status: "past_due",
  collection_method: "charge_automatically",
  latest_invoice: "in_current",
};
const invoice = {
  id: "in_current",
  customer: "cus_current",
  status: "open",
  billing_reason: "subscription_cycle",
  collection_method: "charge_automatically",
  amount_remaining: 2500,
  parent: { subscription_details: { subscription: "sub_current" } },
  hosted_invoice_url: "https://invoice.stripe.com/i/current",
};

describe("openRenewalInvoice", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockContext.mockResolvedValue({
      user: { id: "user_current" },
      stripeCustomerId: "cus_current",
    } as never);
    mockList.mockResolvedValue({
      data: [subscription],
      has_more: false,
    } as never);
    mockRetrieve.mockResolvedValue(invoice as never);
  });

  it("opens the freshly retrieved invoice for the authenticated current subscription", async () => {
    const { default: open } = await import("../renewal-invoice");
    await expect(open()).resolves.toBe(invoice.hosted_invoice_url);
    expect(mockAssertAllowed).toHaveBeenCalledWith("user_current");
    expect(mockList).toHaveBeenCalledWith({
      customer: "cus_current",
      status: "all",
      limit: 10,
    });
    expect(mockRetrieve).toHaveBeenCalledWith("in_current");
  });

  it.each([
    ["canceled", { status: "canceled" }],
    ["healthy", { status: "active" }],
    ["scheduled cancellation", { cancel_at_period_end: true }],
    ["scheduled end", { cancel_at: 123 }],
    ["paused", { pause_collection: { behavior: "void" } }],
    ["another customer", { customer: "cus_other" }],
  ])(
    "does not offer payment for a %s subscription",
    async (_name, overrides) => {
      mockList.mockResolvedValue({
        data: [{ ...subscription, ...overrides }],
        has_more: false,
      } as never);
      const { default: open } = await import("../renewal-invoice");
      await expect(open()).rejects.toThrow("No payable renewal invoice");
    },
  );

  it.each([
    ["paid", { status: "paid" }],
    ["void", { status: "void" }],
    ["written off", { status: "uncollectible" }],
    ["settled", { amount_remaining: 0 }],
    ["manual", { collection_method: "send_invoice" }],
    ["upgrade", { billing_reason: "subscription_update" }],
    ["another customer", { customer: "cus_other" }],
    [
      "another subscription",
      { parent: { subscription_details: { subscription: "sub_old" } } },
    ],
    ["stale", { id: "in_old" }],
  ])("rejects a %s invoice", async (_name, overrides) => {
    mockRetrieve.mockResolvedValue({ ...invoice, ...overrides } as never);
    const { default: open } = await import("../renewal-invoice");
    await expect(open()).rejects.toThrow("No payable renewal invoice");
  });

  it.each([
    { data: [subscription], has_more: true },
    {
      data: [subscription, { ...subscription, id: "sub_other" }],
      has_more: false,
    },
    { data: [], has_more: false },
  ])("rejects incomplete or ambiguous subscription history", async (result) => {
    mockList.mockResolvedValue(result as never);
    const { default: open } = await import("../renewal-invoice");
    await expect(open()).rejects.toThrow("No payable renewal invoice");
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  it.each([
    null,
    "https://example.com/invoice",
    "http://invoice.stripe.com/i/current",
  ])("rejects an unavailable or untrusted payment URL", async (url) => {
    mockRetrieve.mockResolvedValue({
      ...invoice,
      hosted_invoice_url: url,
    } as never);
    const { default: open } = await import("../renewal-invoice");
    await expect(open()).rejects.toThrow("Invoice payment page is unavailable");
  });

  it("does not reach Stripe when billing authorization fails", async () => {
    mockContext.mockRejectedValue(
      new Error("Only admins or owners can manage billing") as never,
    );
    const { default: open } = await import("../renewal-invoice");
    await expect(open()).rejects.toThrow("Only admins or owners");
    expect(mockList).not.toHaveBeenCalled();
  });

  it("does not reach Stripe for a suspended account", async () => {
    mockAssertAllowed.mockRejectedValue(new Error("Suspended") as never);
    const { default: open } = await import("../renewal-invoice");
    await expect(open()).rejects.toThrow("Suspended");
    expect(mockList).not.toHaveBeenCalled();
  });
});
