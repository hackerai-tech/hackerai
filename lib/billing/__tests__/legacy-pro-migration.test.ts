import type Stripe from "stripe";
import {
  applyLegacyProMigration,
  isMonthlyRenewal,
  legacyProManifestSchema,
  validateMigrationPrices,
  validateMigrationSubscription,
  validateMigrationCustomer,
} from "../legacy-pro-migration";

const seconds = (date: string) => Date.parse(date) / 1000;
const now = seconds("2027-01-01T12:00:00Z");
const entry = {
  subscriptionId: "sub_test",
  notifiedAt: now,
  effectiveAt: seconds("2027-02-28T12:00:00Z"),
  noticeReceipt: "delivery-test",
};
const manifest = {
  accountId: "acct_test",
  livemode: false,
  sourcePriceId: "price_source",
  targetPriceId: "price_target",
  entries: [entry],
};
function price(amount = 2000): Stripe.Price {
  return {
    id: amount === 2000 ? "price_source" : "price_target",
    livemode: false,
    active: true,
    type: "recurring",
    currency: "usd",
    unit_amount: amount,
    product: "prod_pro",
    tax_behavior: "unspecified",
    lookup_key: amount === 2900 ? "pro-monthly-plan-29-experiment" : null,
    recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
    billing_scheme: "per_unit",
  } as Stripe.Price;
}
function subscription(): Stripe.Subscription {
  return {
    id: "sub_test",
    livemode: false,
    status: "active",
    customer: "cus_test",
    billing_cycle_anchor: seconds("2026-12-31T12:00:00Z"),
    items: {
      has_more: false,
      data: [
        {
          price: price(),
          quantity: 1,
          discounts: [],
          current_period_start: seconds("2026-12-31T12:00:00Z"),
          current_period_end: seconds("2027-01-31T12:00:00Z"),
        },
      ],
    },
    discounts: [],
    automatic_tax: { enabled: false },
    collection_method: "charge_automatically",
    metadata: {},
  } as unknown as Stripe.Subscription;
}
const validate = (sub = subscription(), change = {}) =>
  validateMigrationSubscription(manifest, { ...entry, ...change }, sub, now);

describe("legacy Pro renewal migration", () => {
  it("accepts only the reviewed $20/$29 monthly product pair", () => {
    expect(() =>
      validateMigrationPrices(manifest, price(), price(2900)),
    ).not.toThrow();
    for (const patch of [
      { unit_amount: 2500 },
      { livemode: true },
      { product: "prod_other" },
      { lookup_key: "ultra-monthly-plan" },
      { recurring: { interval: "year" } },
    ]) {
      expect(() =>
        validateMigrationPrices(manifest, price(), {
          ...price(2900),
          ...patch,
        } as Stripe.Price),
      ).toThrow();
    }
  });
  it("rejects duplicate subscriptions, missing receipts and a foreign live source", () => {
    expect(legacyProManifestSchema.safeParse(manifest).success).toBe(true);
    for (const patch of [
      { entries: [entry, entry] },
      { entries: [{ ...entry, noticeReceipt: "" }] },
      { livemode: true },
    ]) {
      expect(
        legacyProManifestSchema.safeParse({ ...manifest, ...patch }).success,
      ).toBe(false);
    }
  });
  it("clamps Jan 31 to Feb 28 and returns to March 31 without changing time", () => {
    expect(isMonthlyRenewal(subscription(), entry.effectiveAt)).toBe(true);
    expect(
      isMonthlyRenewal(subscription(), seconds("2027-03-31T12:00:00Z")),
    ).toBe(true);
    expect(
      isMonthlyRenewal(subscription(), seconds("2027-03-28T12:00:00Z")),
    ).toBe(false);
    expect(isMonthlyRenewal(subscription(), entry.effectiveAt + 1)).toBe(false);
  });
  it("handles leap year and exact next renewal", () => {
    const sub = subscription();
    sub.items.data[0].current_period_end = seconds("2028-01-31T12:00:00Z");
    expect(isMonthlyRenewal(sub, seconds("2028-02-29T12:00:00Z"))).toBe(true);
    expect(isMonthlyRenewal(sub, sub.items.data[0].current_period_end)).toBe(
      true,
    );
  });
  it("requires 30 days notice and 48 hours operational lead time", () => {
    expect(() => validate()).not.toThrow();
    expect(() =>
      validate(undefined, { notifiedAt: entry.effectiveAt - 29 * 86400 }),
    ).toThrow();
    expect(() => validate(undefined, { notifiedAt: now + 1 })).toThrow();
    expect(() =>
      validateMigrationSubscription(
        manifest,
        entry,
        subscription(),
        entry.effectiveAt - 86400,
      ),
    ).toThrow();
  });
  it.each([
    { status: "past_due" },
    { schedule: "sched_other" },
    { cancel_at_period_end: true },
    { cancel_at: entry.effectiveAt },
    { pause_collection: { behavior: "void" } },
    { pending_update: {} },
    { discounts: ["di_test"] },
    { automatic_tax: { enabled: true } },
    { metadata: { hackeraiPauseId: "pause_test" } },
    { metadata: { legacyProMigration: "done" } },
    { trial_end: now - 1 },
    { collection_method: "send_invoice" },
  ])("skips changed or nonstandard subscriptions: %j", (patch) => {
    expect(() =>
      validate({ ...subscription(), ...patch } as Stripe.Subscription),
    ).toThrow();
  });
  it("never enrolls $25, annual, multi-seat or multi-item subscriptions", () => {
    for (const modify of [
      (s: Stripe.Subscription) => {
        s.items.data[0].price.id = "price_25";
      },
      (s: Stripe.Subscription) => {
        s.items.data[0].quantity = 2;
      },
      (s: Stripe.Subscription) => {
        s.items.data.push(s.items.data[0]);
      },
    ]) {
      const sub = subscription();
      modify(sub);
      expect(() => validate(sub)).toThrow();
    }
  });
  it("requires manual review of customer discounts and credits", () => {
    expect(() =>
      validateMigrationCustomer({ deleted: true } as Stripe.DeletedCustomer),
    ).toThrow();
    expect(() =>
      validateMigrationCustomer({ balance: -100 } as Stripe.Customer),
    ).toThrow();
    expect(() =>
      validateMigrationCustomer({
        balance: 0,
        discount: { id: "di_test" },
      } as Stripe.Customer),
    ).toThrow();
    expect(() =>
      validateMigrationCustomer({ balance: 0 } as Stripe.Customer),
    ).not.toThrow();
  });
  function client() {
    const sub = subscription();
    const phase = {
      start_date: sub.items.data[0].current_period_start,
      end_date: sub.items.data[0].current_period_end,
      items: [{ price: "price_source", quantity: 1 }],
    };
    const readback = {
      status: "active",
      end_behavior: "release",
      phases: [
        { ...phase, end_date: entry.effectiveAt, proration_behavior: "none" },
        {
          start_date: entry.effectiveAt,
          items: [{ price: "price_target" }],
          proration_behavior: "none",
        },
      ],
    };
    return {
      subscriptions: { retrieve: jest.fn().mockResolvedValue(sub) },
      customers: { retrieve: jest.fn().mockResolvedValue({ balance: 0 }) },
      subscriptionSchedules: {
        create: jest.fn().mockResolvedValue({
          id: "sched_test",
          status: "active",
          phases: [phase],
        }),
        update: jest.fn().mockResolvedValue(readback),
        retrieve: jest.fn().mockResolvedValue(readback),
        release: jest.fn(),
      },
    };
  }
  it("keeps $20 through grace renewals and schedules $29 without immediate item updates", async () => {
    const stripe = client();
    await expect(
      applyLegacyProMigration(
        stripe as unknown as Stripe,
        manifest,
        entry,
        now,
      ),
    ).resolves.toEqual({
      subscriptionId: "sub_test",
      scheduleId: "sched_test",
      effectiveAt: entry.effectiveAt,
    });
    const params = stripe.subscriptionSchedules.update.mock.calls[0][1];
    expect(params.proration_behavior).toBe("none");
    expect(params.phases[0].end_date).toBe(entry.effectiveAt);
    expect(params.phases[0].items[0].price).toBe("price_source");
    expect(params.phases[1].items[0].price).toBe("price_target");
    expect(params.end_behavior).toBe("release");
  });
  it("stops on timeout without releasing a potentially committed schedule or retrying", async () => {
    const stripe = client();
    stripe.subscriptionSchedules.update.mockRejectedValue(new Error("timeout"));
    await expect(
      applyLegacyProMigration(
        stripe as unknown as Stripe,
        manifest,
        entry,
        now,
      ),
    ).rejects.toThrow("timeout");
    expect(stripe.subscriptionSchedules.create).toHaveBeenCalledTimes(1);
    expect(stripe.subscriptionSchedules.release).not.toHaveBeenCalled();
  });
  it("detects a read-back mismatch and refuses changed subscription before any write", async () => {
    const stripe = client();
    stripe.subscriptionSchedules.retrieve.mockResolvedValue({
      status: "released",
    });
    await expect(
      applyLegacyProMigration(
        stripe as unknown as Stripe,
        manifest,
        entry,
        now,
      ),
    ).rejects.toThrow("read-back");
    const changed = client();
    changed.subscriptions.retrieve.mockResolvedValue({
      ...subscription(),
      cancel_at_period_end: true,
    });
    await expect(
      applyLegacyProMigration(
        changed as unknown as Stripe,
        manifest,
        entry,
        now,
      ),
    ).rejects.toThrow();
    expect(changed.subscriptionSchedules.create).not.toHaveBeenCalled();
  });
});
