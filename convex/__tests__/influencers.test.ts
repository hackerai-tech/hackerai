jest.mock("../_generated/server", () => ({
  mutation: (x: unknown) => x,
  query: (x: unknown) => x,
}));
import * as functions from "../influencers";
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

  it("requires service authorization on administrative and money operations", async () => {
    const db = database();
    for (const name of [
      "getPartner",
      "reservePayout",
      "finishPayout",
      "syncInvoice",
      "attribute",
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
