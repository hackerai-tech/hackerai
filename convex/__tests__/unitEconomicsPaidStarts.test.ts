import { describe, it, expect, jest } from "@jest/globals";
import { recordPaidStartEventInternal } from "../unitEconomicsLib";

type PaidStartEventRow = {
  _id: string;
  idempotency_key: string;
  source_event_id: string;
  entity_type: "user" | "organization";
  entity_id: string;
  user_id?: string;
};

type PaidStartMixDailyRow = {
  _id: string;
  day: string;
  tier: string;
  plan: string;
  billing_interval: string;
  paid_account_start_count: number;
  paid_user_start_count: number;
  paid_seat_count: number;
};

function makeMockCtx(opts?: {
  events?: PaidStartEventRow[];
  mixRows?: PaidStartMixDailyRow[];
}) {
  const events: PaidStartEventRow[] = [...(opts?.events ?? [])];
  const mixRows: PaidStartMixDailyRow[] = [...(opts?.mixRows ?? [])];
  let nextId = 1;
  const mintId = () => `id-${nextId++}`;

  const buildQuery = (table: string) => ({
    withIndex: jest.fn((_indexName: string, predicate: any) => {
      const captured: Record<string, string> = {};
      const captureProxy = {
        eq: (field: string, value: string) => {
          captured[field] = value;
          return captureProxy;
        },
      };
      predicate(captureProxy);

      const matches = (() => {
        if (table === "paid_start_events") {
          return events.filter(
            (row) => row.idempotency_key === captured.idempotency_key,
          );
        }
        if (table === "paid_start_mix_daily") {
          return mixRows.filter(
            (row) =>
              row.day === captured.day &&
              row.tier === captured.tier &&
              row.billing_interval === captured.billing_interval &&
              row.plan === captured.plan,
          );
        }
        return [];
      })();

      return {
        unique: async () => {
          if (matches.length === 0) return null;
          if (matches.length > 1) throw new Error(`duplicate ${table} rows`);
          return matches[0];
        },
      };
    }),
  });

  const ctx: any = {
    db: {
      query: jest.fn((table: string) => buildQuery(table)),
      insert: jest.fn(async (table: string, doc: any) => {
        const id = mintId();
        const row = { _id: id, ...doc };
        if (table === "paid_start_events") events.push(row);
        else if (table === "paid_start_mix_daily") mixRows.push(row);
        else throw new Error(`unexpected table: ${table}`);
        return id;
      }),
      patch: jest.fn(async (id: string, patch: any) => {
        const row = mixRows.find((candidate) => candidate._id === id);
        if (!row) throw new Error(`row ${id} not found`);
        Object.assign(row, patch);
      }),
    },
  };

  return { ctx, events, mixRows };
}

describe("paid start tracking", () => {
  it("records account, user, and seat start counts idempotently", async () => {
    const { ctx, events, mixRows } = makeMockCtx();
    const occurredAt = Date.UTC(2026, 0, 15, 12);

    const first = await recordPaidStartEventInternal(ctx, {
      entityType: "organization",
      entityId: "org_1",
      userId: "user_1",
      organizationId: "org_1",
      sourceEventId: "in_1",
      occurredAt,
      conversionType: "free_to_paid",
      tier: "ultra",
      plan: "ultra-yearly-plan",
      paidAccountStartCount: 1,
      paidUserStartCount: 4,
      paidSeatCount: 5,
      billingInterval: "year",
      billingIntervalCount: 1,
      quantity: 5,
      userCount: 4,
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
      stripeInvoiceId: "in_1",
      stripePriceId: "price_1",
    });

    const duplicate = await recordPaidStartEventInternal(ctx, {
      entityType: "organization",
      entityId: "org_1",
      userId: "user_1",
      sourceEventId: "in_1",
      occurredAt,
      conversionType: "free_to_paid",
      tier: "ultra",
      plan: "ultra-yearly-plan",
      billingInterval: "year",
    });

    expect(first).toEqual({ alreadyRecorded: false });
    expect(duplicate).toEqual({ alreadyRecorded: true });
    expect(events).toHaveLength(1);
    expect(mixRows).toMatchObject([
      {
        day: "2026-01-15",
        tier: "ultra",
        plan: "ultra-yearly-plan",
        billing_interval: "year",
        paid_account_start_count: 1,
        paid_user_start_count: 4,
        paid_seat_count: 5,
      },
    ]);
    expect(mixRows[0]).not.toHaveProperty("gross_revenue_dollars");
    expect(mixRows[0]).not.toHaveProperty("net_revenue_dollars");
  });

  it("aggregates multiple real starts into the same daily mix segment", async () => {
    const { ctx, mixRows } = makeMockCtx();
    const occurredAt = Date.UTC(2026, 0, 15, 12);

    await recordPaidStartEventInternal(ctx, {
      entityType: "user",
      entityId: "user_1",
      userId: "user_1",
      sourceEventId: "in_1",
      occurredAt,
      conversionType: "free_to_paid",
      tier: "pro-plus",
      plan: "pro-plus-monthly-plan",
      billingInterval: "month",
    });
    await recordPaidStartEventInternal(ctx, {
      entityType: "user",
      entityId: "user_2",
      userId: "user_2",
      sourceEventId: "in_2",
      occurredAt,
      conversionType: "free_to_paid",
      tier: "pro-plus",
      plan: "pro-plus-monthly-plan",
      billingInterval: "month",
    });

    expect(mixRows).toHaveLength(1);
    expect(mixRows[0]).toMatchObject({
      day: "2026-01-15",
      tier: "pro-plus",
      plan: "pro-plus-monthly-plan",
      billing_interval: "month",
      paid_account_start_count: 2,
      paid_user_start_count: 2,
      paid_seat_count: 2,
    });
  });
});
