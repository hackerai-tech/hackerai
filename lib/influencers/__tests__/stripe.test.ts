import { reconcileInfluencerInvoice, handleInfluencerEvent } from "../stripe";

function pages<T>(rows: T[]) {
  return {
    async *[Symbol.asyncIterator]() {
      yield* rows;
    },
  };
}
function fixture() {
  const paidAt = 1_700_000_000;
  const line = {
    parent: { subscription_item_details: { subscription: "sub_one" } },
    pricing: { price_details: { price: "price_month" } },
  };
  const invoice: any = {
    id: "in_one",
    customer: "cus_one",
    parent: { subscription_details: { subscription: "sub_one" } },
    status: "paid",
    amount_paid: 2750,
    total: 2750,
    total_excluding_tax: 2500,
    status_transitions: { paid_at: paidAt },
    created: paidAt,
    currency: "usd",
    lines: { data: [line], has_more: false },
  };
  const charge: any = {
    id: "ch_one",
    customer: "cus_one",
    paid: true,
    amount_captured: 2750,
    amount_refunded: 0,
    currency: "usd",
    disputed: false,
  };
  const history = [invoice];
  const refunds: any[] = [],
    disputes: any[] = [],
    credits: any[] = [];
  const stripe: any = {
    invoices: {
      retrieve: jest.fn(async () => invoice),
      list: jest.fn(() => pages(history)),
    },
    subscriptions: {
      list: jest.fn(() => pages([{ id: "sub_one", created: paidAt - 10 }])),
      retrieve: jest.fn(async () => ({ id: "sub_one", created: paidAt - 10 })),
    },
    prices: {
      retrieve: jest.fn(async () => ({
        recurring: { interval: "month", interval_count: 1 },
      })),
    },
    invoicePayments: {
      list: jest.fn(() =>
        pages([{ amount_paid: 2750, payment: { payment_intent: "pi_one" } }]),
      ),
    },
    paymentIntents: {
      retrieve: jest.fn(async () => ({ latest_charge: "ch_one" })),
    },
    charges: { retrieve: jest.fn(async () => charge) },
    refunds: { list: jest.fn(() => pages(refunds)) },
    disputes: { list: jest.fn(() => pages(disputes)) },
    creditNotes: { list: jest.fn(() => pages(credits)) },
  };
  const convex: any = {
    query: jest.fn(async () => ({ created_at: (paidAt - 60) * 1000 })),
    mutation: jest.fn(async () => null),
  };
  const run = async () => {
    await reconcileInfluencerInvoice(stripe, convex, invoice.id);
    return convex.mutation.mock.calls.at(-1)?.[1];
  };
  return {
    stripe,
    convex,
    invoice,
    charge,
    history,
    refunds,
    disputes,
    credits,
    run,
  };
}

describe("Stripe commission reconciliation", () => {
  it("uses collected discounted revenue excluding tax", async () => {
    const f = fixture();
    expect(await f.run()).toMatchObject({
      netCents: 2500,
      grossCents: 2750,
      eligible: true,
      interval: "month",
      paidAt: 1_700_000_000_000,
    });
  });
  it("prorates refunds excluding their tax component", async () => {
    const f = fixture();
    f.charge.amount_refunded = 1100;
    expect(await f.run()).toMatchObject({ netCents: 1500 });
  });
  it("does not double subtract refunds linked to credit notes", async () => {
    const f = fixture();
    f.charge.amount_refunded = 550;
    f.credits.push({
      status: "issued",
      post_payment_amount: 825,
      refunds: [{ amount_refunded: 550 }],
    });
    expect(await f.run()).toMatchObject({ netCents: 1750 });
  });
  it("withholds open disputes and restores eligibility only when won", async () => {
    const f = fixture();
    f.charge.disputed = true;
    f.disputes.push({ status: "needs_response" });
    expect(await f.run()).toMatchObject({ reviewReason: "open_dispute" });
    f.disputes[0].status = "lost";
    expect(await f.run()).toMatchObject({ eligible: false });
    f.disputes[0].status = "won";
    expect(await f.run()).toMatchObject({ eligible: true });
    expect((await f.run()).reviewReason).toBeUndefined();
  });
  it("marks pending refunds and unsupported invoices for review", async () => {
    const f = fixture();
    f.refunds.push({ status: "pending" });
    expect(await f.run()).toMatchObject({ reviewReason: "pending_refund" });
    f.refunds.length = 0;
    f.invoice.lines.data.push({ parent: null });
    expect(await f.run()).toMatchObject({
      reviewReason: "unsupported_invoice_lines",
    });
  });
  it("does not treat out-of-band payments as verified cash", async () => {
    const f = fixture();
    f.stripe.invoicePayments.list.mockImplementation(() => pages([]));
    expect(await f.run()).toMatchObject({
      netCents: 0,
      reviewReason: "no_verified_stripe_payment",
    });
  });
  it("caps commissions at a calendar year even when renewal events arrive first", async () => {
    const f = fixture();
    const first = {
      ...f.invoice,
      id: "in_first",
      created: f.invoice.created - 366 * 86400,
      status_transitions: {
        paid_at: f.invoice.status_transitions.paid_at - 366 * 86400,
      },
    };
    f.history.push(first);
    expect(await f.run()).toMatchObject({ eligible: false });
  });
  it("pays only the first annual invoice, including early annual renewals", async () => {
    const f = fixture();
    f.stripe.prices.retrieve.mockResolvedValue({
      recurring: { interval: "year", interval_count: 1 },
    });
    expect(await f.run()).toMatchObject({ eligible: true, interval: "year" });
    f.history.push({
      ...f.invoice,
      id: "in_earlier",
      created: f.invoice.created - 1000,
      status_transitions: {
        paid_at: f.invoice.status_transitions.paid_at - 1000,
      },
    });
    expect(await f.run()).toMatchObject({ eligible: false });
  });
  it("uses current invoice state for duplicate and stale webhook deliveries", async () => {
    const f = fixture();
    f.charge.amount_refunded = 2750;
    await handleInfluencerEvent(f.stripe, f.convex, {
      type: "invoice.paid",
      data: { object: { id: "in_one", amount_paid: 99999 } },
    } as any);
    expect(f.convex.mutation.mock.calls[0][1]).toMatchObject({
      netCents: 0,
      grossCents: 2750,
    });
  });
  it("reconciles charge adjustments through InvoicePayment without scanning customer history", async () => {
    const f = fixture();
    f.charge.payment_intent = "pi_one";
    f.charge.amount_refunded = 2750;
    f.stripe.invoicePayments.list.mockImplementation(() =>
      pages([
        {
          invoice: "in_one",
          amount_paid: 2750,
          payment: { payment_intent: "pi_one" },
        },
      ]),
    );
    await handleInfluencerEvent(f.stripe, f.convex, {
      type: "charge.refunded",
      data: { object: { id: "ch_one" } },
    } as any);
    expect(f.stripe.invoicePayments.list).toHaveBeenCalledWith({
      payment: { type: "payment_intent", payment_intent: "pi_one" },
      status: "paid",
      limit: 100,
    });
    expect(f.stripe.invoices.retrieve).toHaveBeenCalledTimes(1);
    expect(
      f.stripe.invoices.list.mock.calls.every(
        (call: any[]) => call[0].subscription === "sub_one",
      ),
    ).toBe(true);
    expect(f.convex.mutation.mock.calls[0][1]).toMatchObject({
      invoiceId: "in_one",
      netCents: 0,
    });
  });
  it("ignores one-time purchases and customers without attribution", async () => {
    const f = fixture();
    f.convex.query.mockResolvedValue(null);
    await f.run();
    expect(f.convex.mutation).not.toHaveBeenCalled();
    f.invoice.parent = null;
    await f.run();
    expect(f.convex.mutation).not.toHaveBeenCalled();
  });
});
