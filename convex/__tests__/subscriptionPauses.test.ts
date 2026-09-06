import { describe, it, expect, jest, beforeEach } from "@jest/globals";

jest.mock("../_generated/server", () => ({
  mutation: jest.fn((config: any) => config),
  query: jest.fn((config: any) => config),
}));

jest.mock("convex/values", () => ({
  v: {
    id: jest.fn(() => "id"),
    string: jest.fn(() => "string"),
    number: jest.fn(() => "number"),
    boolean: jest.fn(() => "boolean"),
    optional: jest.fn(() => "optional"),
    object: jest.fn(() => "object"),
    array: jest.fn(() => "array"),
    union: jest.fn(() => "union"),
    literal: jest.fn(() => "literal"),
    null: jest.fn(() => "null"),
  },
}));

jest.mock("../lib/utils", () => ({
  validateServiceKey: jest.fn(),
}));

type Row = Record<string, any>;

/** Minimal in-memory stand-in for the subscription_pauses table. */
function buildDb(rows: Row[]) {
  const byId = new Map(rows.map((row) => [row._id, row]));
  const query = (_table: string) => {
    let matches = [...rows];
    const builder: any = {
      withIndex: jest.fn((indexName: string, apply?: any) => {
        const eq: Record<string, unknown> = {};
        const lte: Record<string, number> = {};
        const capture: any = {
          eq: (field: string, value: unknown) => {
            eq[field] = value;
            return capture;
          },
          lte: (field: string, value: number) => {
            lte[field] = value;
            return capture;
          },
        };
        apply?.(capture);
        matches = rows.filter(
          (row) =>
            Object.entries(eq).every(
              ([field, value]) => row[field] === value,
            ) &&
            Object.entries(lte).every(([field, value]) => row[field] <= value),
        );
        void indexName;
        return builder;
      }),
      order: jest.fn((direction: "asc" | "desc") => {
        matches = [...matches].sort((a, b) =>
          direction === "desc"
            ? (b.requested_at ?? b.resume_at) - (a.requested_at ?? a.resume_at)
            : (a.resume_at ?? a.requested_at) - (b.resume_at ?? b.requested_at),
        );
        return builder;
      }),
      take: jest.fn(async (limit: number) => matches.slice(0, limit)),
    };
    return builder;
  };

  return {
    query: jest.fn(query),
    get: jest.fn(async (id: string) => byId.get(id) ?? null),
    patch: jest.fn(async (id: string, patch: Row) => {
      const row = byId.get(id);
      if (row) Object.assign(row, patch);
    }),
    insert: jest.fn(async (_table: string, row: Row) => {
      const id = `pause_${rows.length + 1}`;
      const inserted = { _id: id, ...row };
      rows.push(inserted);
      byId.set(id, inserted);
      return id;
    }),
  };
}

function pauseRow(overrides: Row = {}): Row {
  return {
    _id: "pause_1",
    user_id: "user_1",
    stripe_customer_id: "cus_1",
    stripe_subscription_id: "sub_1",
    stripe_price_id: "price_1",
    quantity: 1,
    pause_months: 1,
    requested_at: 1_000,
    pause_effective_at: 2_000,
    resume_at: 3_000,
    status: "paused",
    resume_attempt_count: 0,
    updated_at: 1_000,
    ...overrides,
  };
}

describe("subscription pause lifecycle", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("claims a due pause once and rejects a second automatic claim", async () => {
    const { claimResume } = await import("../subscriptionPauses");
    const rows = [pauseRow()];
    const db = buildDb(rows);

    const first = await (claimResume as any).handler(
      { db },
      { serviceKey: "k", pauseId: "pause_1", now: 5_000, maxAttempts: 3 },
    );
    expect(first).toMatchObject({
      id: "pause_1",
      status: "resuming",
      resumeAttemptCount: 1,
    });

    const second = await (claimResume as any).handler(
      { db },
      { serviceKey: "k", pauseId: "pause_1", now: 5_001, maxAttempts: 3 },
    );
    expect(second).toBeNull();
  });

  it("lets a user retry manually after automatic attempts are exhausted", async () => {
    const { claimResume } = await import("../subscriptionPauses");
    const rows = [
      pauseRow({ status: "resume_failed", resume_attempt_count: 3 }),
    ];
    const db = buildDb(rows);

    const automatic = await (claimResume as any).handler(
      { db },
      { serviceKey: "k", pauseId: "pause_1", now: 5_000, maxAttempts: 3 },
    );
    expect(automatic).toBeNull();

    const manual = await (claimResume as any).handler(
      { db },
      {
        serviceKey: "k",
        pauseId: "pause_1",
        now: 5_000,
        manual: true,
        maxAttempts: 3,
      },
    );
    expect(manual).toMatchObject({ status: "resuming", resumeAttemptCount: 4 });
  });

  it("recovers a claim abandoned by a crashed worker", async () => {
    const { claimResume } = await import("../subscriptionPauses");
    const rows = [
      pauseRow({
        status: "resuming",
        resume_claimed_at: 1_000,
        resume_attempt_count: 1,
      }),
    ];
    const db = buildDb(rows);

    const stale = await (claimResume as any).handler(
      { db },
      {
        serviceKey: "k",
        pauseId: "pause_1",
        now: 1_000 + 16 * 60 * 1000,
        maxAttempts: 3,
      },
    );
    expect(stale).toMatchObject({ status: "resuming", resumeAttemptCount: 2 });
  });

  it("lists only pauses whose resume time has passed", async () => {
    const { listDueResumes } = await import("../subscriptionPauses");
    const rows = [
      pauseRow({ _id: "pause_due", resume_at: 3_000 }),
      pauseRow({ _id: "pause_future", resume_at: 9_000 }),
      pauseRow({
        _id: "pause_scheduled_due",
        status: "scheduled",
        resume_at: 2_500,
      }),
      pauseRow({ _id: "pause_done", status: "resumed", resume_at: 1_000 }),
    ];
    const db = buildDb(rows);

    const due = await (listDueResumes as any).handler(
      { db },
      { serviceKey: "k", now: 4_000 },
    );

    expect(due.map((row: Row) => row.id)).toEqual([
      "pause_scheduled_due",
      "pause_due",
    ]);
  });

  it("cancels only scheduled pauses when the plan is kept", async () => {
    const { cancelScheduledPause } = await import("../subscriptionPauses");
    const rows = [
      pauseRow({ _id: "pause_scheduled", status: "scheduled" }),
      pauseRow({ _id: "pause_already_paused", status: "paused" }),
    ];
    const db = buildDb(rows);

    const result = await (cancelScheduledPause as any).handler(
      { db },
      { serviceKey: "k", stripeSubscriptionId: "sub_1", canceledAt: 7_000 },
    );

    expect(result).toEqual({ canceledCount: 1 });
    expect(rows[0].status).toBe("canceled");
    expect(rows[1].status).toBe("paused");
  });

  it("returns the existing active pause instead of inserting a duplicate", async () => {
    const { recordScheduledPause } = await import("../subscriptionPauses");
    const rows = [pauseRow({ status: "scheduled" })];
    const db = buildDb(rows);

    const result = await (recordScheduledPause as any).handler(
      { db },
      {
        serviceKey: "k",
        userId: "user_1",
        stripeCustomerId: "cus_1",
        stripeSubscriptionId: "sub_1",
        stripePriceId: "price_1",
        quantity: 1,
        pauseMonths: 2,
        requestedAt: 5_000,
        pauseEffectiveAt: 6_000,
        resumeAt: 7_000,
      },
    );

    expect(result).toEqual({ pauseId: "pause_1", created: false });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("only exposes the caller's own active pause", async () => {
    const { getMyActivePause } = await import("../subscriptionPauses");
    const rows = [
      pauseRow({ _id: "pause_mine", user_id: "user_1", requested_at: 1 }),
      pauseRow({
        _id: "pause_mine_resumed",
        user_id: "user_1",
        status: "resumed",
        requested_at: 2,
      }),
    ];
    const db = buildDb(rows);

    const anonymous = await (getMyActivePause as any).handler({
      db,
      auth: { getUserIdentity: async () => null },
    });
    expect(anonymous).toBeNull();

    const mine = await (getMyActivePause as any).handler({
      db,
      auth: { getUserIdentity: async () => ({ subject: "user_1" }) },
    });
    expect(mine).toMatchObject({ id: "pause_mine", status: "paused" });
  });
});
