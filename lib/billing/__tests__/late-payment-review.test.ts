import type Stripe from "stripe";
import {
  listLatePaymentReviews,
  requireLatePaymentReview,
} from "../late-payment-review";

function fixture() {
  const snapshot = {
    id: "in_late",
    customer: "cus_test",
    parent: { subscription_details: { subscription: "sub_canceled" } },
    status: "paid",
    amount_paid: 6000,
    currency: "usd",
    livemode: false,
    metadata: {},
  } as Stripe.Invoice;
  let current = { ...snapshot, metadata: { supportNote: "retain" } };
  const retrieve = jest.fn(async () => current);
  const update = jest.fn(async (_id, { metadata }) => {
    current = { ...current, metadata: { ...current.metadata, ...metadata } };
    return current;
  });
  const stripe = { invoices: { retrieve, update } } as unknown as Stripe;
  return {
    snapshot,
    retrieve,
    update,
    run: () =>
      requireLatePaymentReview(stripe, snapshot, "requested_cancellation"),
  };
}

describe("late payment support review", () => {
  it("reads every search page, deduplicates cases, and excludes fresh resolutions", async () => {
    const f = fixture();
    const retrieve = jest.fn(async (id) => ({
      ...f.snapshot,
      id,
      metadata: {
        hackeraiLatePaymentReview: "required",
        ...(id === "in_resolved" && {
          hackeraiLatePaymentResolution: "replacement_month",
        }),
      },
    }));
    const stripe = {
      invoices: {
        search: jest.fn(() => ({
          async *[Symbol.asyncIterator]() {
            yield { id: "in_resolved" };
            yield { id: "in_unresolved" };
            yield { id: "in_unresolved" };
          },
        })),
        retrieve,
      },
    } as unknown as Stripe;
    const result = [];
    for await (const invoice of listLatePaymentReviews(stripe, false))
      result.push(invoice.id);
    expect(result).toEqual(["in_unresolved"]);
    expect(retrieve).toHaveBeenCalledTimes(2);
  });

  it("rejects a queue read from the wrong environment", async () => {
    const f = fixture();
    const stripe = {
      invoices: { search: () => [f.snapshot], retrieve: f.retrieve },
    } as unknown as Stripe;
    const iterator = listLatePaymentReviews(stripe, true);
    await expect(iterator.next()).rejects.toThrow("environment mismatch");
  });

  it("retains one invoice-linked case across duplicate deliveries", async () => {
    const f = fixture();
    await f.run();
    await f.run();
    expect(f.update).toHaveBeenCalledTimes(1);
    expect(await f.retrieve()).toMatchObject({
      metadata: {
        supportNote: "retain",
        hackeraiLatePaymentReview: "required",
        hackeraiLatePaymentReviewReason: "requested_cancellation",
        hackeraiLatePaymentReviewOwner: "billing-support",
      },
    });
  });

  it("honors a support resolution newer than the webhook snapshot", async () => {
    const f = fixture();
    f.retrieve.mockResolvedValue({
      ...f.snapshot,
      metadata: {
        supportNote: "retain",
        hackeraiLatePaymentResolution: "replacement_month",
      },
    });
    await f.run();
    expect(f.update).not.toHaveBeenCalled();
  });

  it.each([
    { id: "in_other" },
    { customer: "cus_other" },
    { parent: { subscription_details: { subscription: "sub_other" } } },
    { livemode: true },
    { currency: "eur" },
    { status: "void" },
    { amount_paid: 3000 },
  ])(
    "retries instead of marking a mismatched invoice: %j",
    async (override) => {
      const f = fixture();
      f.retrieve.mockResolvedValue({ ...f.snapshot, ...override } as never);
      await expect(f.run()).rejects.toThrow(
        "Late payment review invoice changed",
      );
      expect(f.update).not.toHaveBeenCalled();
    },
  );

  it.each([{ amount_paid: 0 }, { status: "open" }])(
    "does not queue an invoice without a settled positive payment: %j",
    async (override) => {
      const f = fixture();
      Object.assign(f.snapshot, override);
      await f.run();
      expect(f.retrieve).not.toHaveBeenCalled();
      expect(f.update).not.toHaveBeenCalled();
    },
  );

  it("propagates a failed write for webhook retry", async () => {
    const f = fixture();
    f.update.mockRejectedValueOnce(new Error("unavailable"));
    await expect(f.run()).rejects.toThrow("unavailable");
    await f.run();
    expect(f.update).toHaveBeenCalledTimes(2);
  });
});
