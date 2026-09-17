jest.mock("../_generated/server", () => ({
  mutation: (x: unknown) => x,
  query: (x: unknown) => x,
}));
import * as ledger from "../influencers";
import * as analytics from "../influencerAnalytics";
const functions = { ...ledger, ...analytics };
import { PAYOUT_HOLD_MS } from "../../lib/influencers/policy";

type Row = Record<string, any>;
function database() {
  const tables: Record<string, Row[]> = {};
  const get = async (id: string) =>
    Object.values(tables)
      .flat()
      .find((row) => row._id === id) ?? null;
  const ctx = {
    db: {
      get,
      query: (table: string) => ({
        withIndex: (_index: string, predicate: (q: any) => unknown) => {
          const filters: [string, unknown][] = [];
          const q = {
            eq: (key: string, value: unknown) => {
              filters.push([key, value]);
              return q;
            },
          };
          predicate(q);
          const rows = (tables[table] ?? []).filter((row) =>
            filters.every(([key, value]) => row[key] === value),
          );
          return {
            unique: async () => {
              if (rows.length > 1) throw new Error("Not unique");
              return rows[0] ?? null;
            },
            first: async () => rows[0] ?? null,
            take: async (n: number) => rows.slice(0, n),
          };
        },
      }),
      insert: async (table: string, values: Row) => {
        tables[table] ??= [];
        const row = {
          ...values,
          _id: `${table}_${tables[table].length}`,
          _creationTime: Date.now(),
        };
        tables[table].push(row);
        return row._id;
      },
      patch: async (id: string, values: Row) => {
        const row = await get(id);
        if (!row) throw new Error("Missing row");
        Object.assign(row, values);
      },
    },
  };
  const call = (name: keyof typeof functions, args: Row) =>
    (functions[name] as any).handler(ctx, {
      serviceKey: "test-service",
      ...args,
    });
  return { call, tables };
}

describe("influencer financial ledger", () => {
  let now: number;
  beforeEach(() => {
    now = 1_700_000_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    process.env.CONVEX_SERVICE_ROLE_KEY = "test-service";
  });
  afterEach(() => jest.restoreAllMocks());

  async function setup() {
    const db = database();
    const partnerId = await db.call("createPartner", {
      code: "medusa",
      name: "Medusa",
      contactEmail: "partner@example.test",
      ownerIdentity: "free_quota:v1:owner",
    });
    const signup = {
      code: "medusa",
      identity: "free_quota:v1:customer",
      userId: "user_new",
      clickedAt: now - 1000,
      userCreatedAt: now - 500,
    };
    await db.call("attribute", signup);
    await db.call("bindCustomer", {
      identity: signup.identity,
      customerId: "cus_new",
    });
    const invoice = {
      invoiceId: "in_one",
      customerId: "cus_new",
      subscriptionId: "sub_one",
      currency: "usd",
      interval: "month",
      paidAt: now,
      grossCents: 2500,
      netCents: 2500,
      eligible: true,
      observedAt: now,
    };
    await db.call("syncInvoice", invoice);
    return { ...db, partnerId, signup, invoice };
  }

  it("queues each consented signup and invoice transition once, including refund deltas", async () => {
    const db = database();
    await db.call("createPartner", {
      code: "partner",
      name: "Partner",
      contactEmail: "owner@example.test",
      ownerIdentity: "free_quota:v1:owner",
    });
    const signup = {
      code: "partner",
      identity: "free_quota:v1:new",
      userId: "user",
      clickedAt: now - 1000,
      userCreatedAt: now - 500,
      analyticsVisitorId: "00000000-0000-4000-8000-000000000001",
    };
    await db.call("attribute", signup);
    await db.call("attribute", signup);
    await db.call("bindCustomer", {
      identity: signup.identity,
      customerId: "cus_private",
    });
    const invoice = {
      invoiceId: "in_private",
      customerId: "cus_private",
      subscriptionId: "sub_private",
      currency: "usd",
      interval: "month",
      paidAt: now,
      grossCents: 2500,
      netCents: 2500,
      eligible: true,
      observedAt: now,
      firstInvoice: true,
    };
    await db.call("recordCheckout", {
      identity: signup.identity,
      attemptId: "cs_one",
      plan: "pro",
      interval: "month",
      timestamp: now + 500,
    });
    await db.call("syncInvoice", invoice);
    await db.call("syncInvoice", { ...invoice, observedAt: now + 1 });
    expect(db.tables.influencer_analytics.map((x) => x.event)).toEqual([
      "influencer_signup_attributed",
      "influencer_checkout_started",
      "influencer_invoice_paid",
      "influencer_first_payment",
    ]);
    await db.call("syncInvoice", {
      ...invoice,
      netCents: 0,
      observedAt: now + 2,
    });
    await db.call("syncInvoice", invoice); // older snapshot cannot restore money or emit another event
    const financial = db.tables.influencer_analytics.filter((x) =>
      x.event.startsWith("influencer_invoice_"),
    );
    expect(financial).toHaveLength(2);
    expect(
      financial.reduce((n, x) => n + x.properties.net_revenue_delta_cents, 0),
    ).toBe(0);
    expect(
      financial.reduce((n, x) => n + x.properties.commission_delta_cents, 0),
    ).toBe(0);
    expect(db.tables.influencer_invoices[0].analytics_revision).toBe(2);
    expect(
      db.tables.influencer_analytics.find(
        (x) => x.event === "influencer_first_payment",
      ).timestamp,
    ).toBe(now + 501);
    await db.call("syncInvoice", {
      ...invoice,
      invoiceId: "in_renewal",
      firstInvoice: false,
      observedAt: now + 3,
    });
    expect(
      db.tables.influencer_analytics.filter(
        (x) => x.event === "influencer_first_payment",
      ),
    ).toHaveLength(1);
    db.tables.account_identities = [
      { latest_user_id: signup.userId, identity_hash: signup.identity },
    ];
    await db.call("optOut", { userId: signup.userId });
    await db.call("optOut", { userId: signup.userId });
    expect(db.tables.influencer_analytics_optouts).toHaveLength(1);
    const pending = await db.call("pending", {});
    expect(pending.every((x: Row) => x.suppressed)).toBe(true);
  });
  it("does not export legacy attributions without a consented visitor identity", async () => {
    const db = await setup();
    await db.call("syncInvoice", { ...db.invoice, firstInvoice: true });
    expect(db.tables.influencer_analytics ?? []).toHaveLength(0);
  });
  it("suppresses future analytics after withdrawal while preserving financial accounting", async () => {
    const db = database();
    const visitorId = "00000000-0000-4000-8000-000000000001";
    await db.call("createPartner", {
      code: "partner",
      name: "Partner",
      contactEmail: "owner@example.test",
      ownerIdentity: "free_quota:v1:owner",
    });
    await db.call("optOut", { visitorId });
    await db.call("attribute", {
      code: "partner",
      identity: "free_quota:v1:new",
      userId: "user",
      clickedAt: now - 1000,
      userCreatedAt: now - 500,
      analyticsVisitorId: visitorId,
    });
    expect(db.tables.influencer_attributions).toHaveLength(1);
    expect(db.tables.influencer_analytics ?? []).toHaveLength(0);
  });
  it("deduplicates sponsorship cost edits and emits signed corrections", async () => {
    const db = database();
    await db.call("createPartner", {
      code: "partner",
      name: "Partner",
      contactEmail: "owner@example.test",
      ownerIdentity: "free_quota:v1:owner",
    });
    await db.call("setSponsorshipCost", {
      code: "partner",
      amountCents: 65000,
    });
    await db.call("setSponsorshipCost", {
      code: "partner",
      amountCents: 65000,
    });
    await db.call("setSponsorshipCost", {
      code: "partner",
      amountCents: 60000,
    });
    expect(
      db.tables.influencer_analytics.map(
        (x) => x.properties.sponsorship_cost_delta_cents,
      ),
    ).toEqual([65000, -5000]);
  });
  it("requires service authorization on administrative and money operations", async () => {
    const db = database();
    for (const name of [
      "getPartner",
      "reservePayout",
      "finishPayout",
      "syncInvoice",
      "attribute",
      "recordVisit",
      "recordCheckout",
      "pending",
      "acknowledge",
      "setSponsorshipCost",
      "optOut",
    ] as const) {
      await expect(db.call(name, { serviceKey: "wrong" })).rejects.toThrow(
        "Unauthorized",
      );
    }
  });
  it("deduplicates invoice delivery and ignores older snapshots", async () => {
    const db = await setup();
    await db.call("syncInvoice", db.invoice);
    await db.call("syncInvoice", {
      ...db.invoice,
      observedAt: now + 10,
      netCents: 1000,
    });
    await db.call("syncInvoice", db.invoice);
    expect(db.tables.influencer_invoices).toHaveLength(1);
    expect(db.tables.influencer_invoices[0].earned_cents).toBe(150);
  });
  it("holds until exactly 30 days, reserves atomically, and records payment once", async () => {
    const db = await setup();
    now += PAYOUT_HOLD_MS - 1;
    await db.call("syncInvoice", { ...db.invoice, observedAt: now });
    await expect(
      db.call("reservePayout", { partnerId: db.partnerId, key: "payout-001" }),
    ).rejects.toThrow("No positive");
    now++;
    const payout = await db.call("reservePayout", {
      partnerId: db.partnerId,
      key: "payout-001",
    });
    expect(payout.amount_cents).toBe(375);
    await expect(
      db.call("reservePayout", { partnerId: db.partnerId, key: "payout-002" }),
    ).rejects.toThrow("existing reserved");
    expect(
      (
        await db.call("reservePayout", {
          partnerId: db.partnerId,
          key: "payout-001",
        })
      )._id,
    ).toBe(payout._id);
    await db.call("finishPayout", {
      key: "payout-001",
      action: "paid",
      reference: "transfer-123",
    });
    await db.call("finishPayout", {
      key: "payout-001",
      action: "paid",
      reference: "transfer-123",
    });
    expect(db.tables.influencer_invoices[0].paid_cents).toBe(375);
  });
  it("normalizes retry references and prevents reusing one transfer for a second payout", async () => {
    const db = await setup();
    now += PAYOUT_HOLD_MS;
    await db.call("syncInvoice", { ...db.invoice, observedAt: now });
    await db.call("reservePayout", {
      partnerId: db.partnerId,
      key: "payout-001",
    });
    await db.call("finishPayout", {
      key: "payout-001",
      action: "paid",
      reference: " transfer-123 ",
    });
    await db.call("finishPayout", {
      key: "payout-001",
      action: "paid",
      reference: " transfer-123 ",
    });
    await db.call("syncInvoice", {
      ...db.invoice,
      invoiceId: "in_two",
      observedAt: now,
    });
    await db.call("reservePayout", {
      partnerId: db.partnerId,
      key: "payout-002",
    });
    await expect(
      db.call("finishPayout", {
        key: "payout-002",
        action: "paid",
        reference: "transfer-123",
      }),
    ).rejects.toThrow("already belongs");
    expect(db.tables.influencer_invoices[1].paid_cents).toBe(0);
  });
  it("accepts Stripe's second-resolution paid timestamp within the signup second", async () => {
    const db = await setup();
    db.tables.influencer_attributions[0].created_at = now + 500;
    now += 500;
    await db.call("syncInvoice", {
      ...db.invoice,
      invoiceId: "in_same_second",
      paidAt: now - 500,
      observedAt: now,
    });
    expect(db.tables.influencer_invoices).toHaveLength(2);
  });
  it("deducts post-payout refunds from the next payout without erasing history", async () => {
    const db = await setup();
    now += PAYOUT_HOLD_MS;
    await db.call("syncInvoice", { ...db.invoice, observedAt: now });
    await db.call("reservePayout", {
      partnerId: db.partnerId,
      key: "payout-001",
    });
    await db.call("finishPayout", {
      key: "payout-001",
      action: "paid",
      reference: "transfer-123",
    });
    await db.call("syncInvoice", {
      ...db.invoice,
      observedAt: now,
      netCents: 0,
    });
    await db.call("syncInvoice", {
      ...db.invoice,
      invoiceId: "in_two",
      grossCents: 6000,
      netCents: 6000,
      observedAt: now,
    });
    const next = await db.call("reservePayout", {
      partnerId: db.partnerId,
      key: "payout-002",
    });
    expect(next.amount_cents).toBe(900 - 375);
    expect(db.tables.influencer_payouts[0].amount_cents).toBe(375);
    await db.call("finishPayout", { key: "payout-002", action: "cancel" });
    expect(db.tables.influencer_invoices[0].paid_cents).toBe(375);
  });
  it("blocks stale reconciliation and invoices requiring review", async () => {
    const db = await setup();
    now += PAYOUT_HOLD_MS;
    await expect(
      db.call("reservePayout", { partnerId: db.partnerId, key: "payout-001" }),
    ).rejects.toThrow("Reconcile");
    await db.call("syncInvoice", {
      ...db.invoice,
      observedAt: now,
      reviewReason: "open_dispute",
    });
    await expect(
      db.call("reservePayout", { partnerId: db.partnerId, key: "payout-001" }),
    ).rejects.toThrow("requiring review");
  });
  it("prevents self-referrals, old accounts, cross-program stacking and overwritten attribution", async () => {
    const db = await setup();
    expect(
      await db.call("attribute", {
        ...db.signup,
        identity: "free_quota:v1:owner",
      }),
    ).toBe(false);
    expect(
      await db.call("attribute", {
        ...db.signup,
        identity: "free_quota:v1:old",
        userCreatedAt: now - 10000,
      }),
    ).toBe(false);
    db.tables.referral_attributions = [
      {
        referred_user_id: "credit_user",
        referred_identity_hash: "free_quota:v1:credit",
      },
    ];
    expect(
      await db.call("attribute", {
        ...db.signup,
        identity: "free_quota:v1:credit",
        userId: "credit_user",
      }),
    ).toBe(false);
    expect(
      await db.call("attribute", { ...db.signup, code: "different" }),
    ).toBe(true);
    expect(db.tables.influencer_attributions).toHaveLength(1);
    await expect(
      db.call("bindCustomer", {
        identity: db.signup.identity,
        customerId: "cus_other",
      }),
    ).rejects.toThrow("already bound");
  });
});
