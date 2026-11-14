import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";

jest.mock("../lib/serviceFunctions", () => ({
  mutation: jest.fn((config: any) => config),
  internalMutation: jest.fn((config: any) => config),
  query: jest.fn((config: any) => config),
  internalQuery: jest.fn((config: any) => config),
}));
jest.mock("convex/values", () => ({
  v: {
    id: jest.fn(() => "id"),
    null: jest.fn(() => "null"),
    string: jest.fn(() => "string"),
    number: jest.fn(() => "number"),
    optional: jest.fn(() => "optional"),
    object: jest.fn(() => "object"),
    union: jest.fn(() => "union"),
    array: jest.fn(() => "array"),
    boolean: jest.fn(() => "boolean"),
    literal: jest.fn(() => "literal"),
    any: jest.fn(() => "any"),
  },
  ConvexError: class ConvexError extends Error {
    data: any;
    constructor(data: any) {
      super(typeof data === "string" ? data : data.message);
      this.data = data;
      this.name = "ConvexError";
    }
  },
}));
jest.mock("../lib/utils", () => ({
  validateServiceKey: jest.fn(),
}));
jest.mock("../lib/logger", () => ({
  convexLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const SERVICE_KEY = "test-service-key";
process.env.CONVEX_SERVICE_ROLE_KEY = SERVICE_KEY;

const STALE_CLAIM_MS = 10 * 60 * 1000;
const EVENT_ID = "evt_test_123";

type Row = {
  _id: string;
  event_id: string;
  source_id?: string;
  processed_at: number;
  status?:
    "pending" | "cleanup_started" | "review_required" | "handled" | "completed";
  claimed_at?: number;
  claim_token?: string;
  review_reason?: string;
  review_customer_id?: string;
  review_resolution?: string;
  reviewed_by?: string;
  reviewed_at?: number;
};

function makeMockCtx(initialRows: Row[] = []) {
  const rows = [...initialRows];

  const queryChain = (eventId: string) => ({
    first: async () => rows.find((r) => r.event_id === eventId) ?? null,
    unique: async () => {
      const matches = rows.filter((r) => r.event_id === eventId);
      if (matches.length === 0) return null;
      if (matches.length > 1) {
        throw new Error(
          `Expected exactly one row for event_id=${eventId}, found ${matches.length}`,
        );
      }
      return matches[0];
    },
  });

  const ctx: any = {
    db: {
      query: jest.fn(() => ({
        withIndex: jest.fn((_indexName: string, predicate: any) => {
          let captured: string | null = null;
          const q = {
            eq: (_field: string, value: string) => {
              captured = value;
              return q;
            },
          };
          predicate(q);
          return queryChain(captured ?? "");
        }),
      })),
      insert: jest.fn(async (_table: string, doc: Omit<Row, "_id">) => {
        const newRow: Row = { _id: `id-${rows.length + 1}`, ...doc };
        rows.push(newRow);
        return newRow._id;
      }),
      patch: jest.fn(async (id: string, patch: Partial<Row>) => {
        const row = rows.find((r) => r._id === id);
        if (!row) throw new Error(`row ${id} not found`);
        Object.assign(row, patch);
      }),
    },
  };

  return { ctx, rows };
}

async function callClaim(ctx: any) {
  const { claimWebhookProcessing } = await import("../extraUsage");
  return (claimWebhookProcessing as any).handler(ctx, {
    serviceKey: SERVICE_KEY,
    eventId: EVENT_ID,
    sourceId: "dp_123",
    claimToken: "token_new",
  });
}

async function callFinalize(ctx: any) {
  const { finalizeWebhookProcessing } = await import("../extraUsage");
  return (finalizeWebhookProcessing as any).handler(ctx, {
    serviceKey: SERVICE_KEY,
    eventId: EVENT_ID,
  });
}

async function callMarkHandled(ctx: any) {
  const { markWebhookHandled } = await import("../extraUsage");
  return (markWebhookHandled as any).handler(ctx, {
    serviceKey: SERVICE_KEY,
    eventId: EVENT_ID,
    claimToken: "token_new",
  });
}

describe("claimWebhookProcessing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date, "now").mockReturnValue(1_000_000);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("inserts a pending row and acquires the claim when no row exists", async () => {
    const { ctx, rows } = makeMockCtx();

    const result = await callClaim(ctx);

    expect(result).toEqual({ state: "acquired" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event_id: EVENT_ID,
      source_id: "dp_123",
      status: "pending",
      claimed_at: 1_000_000,
      claim_token: "token_new",
      processed_at: 1_000_000,
    });
  });

  it("returns already_processed when the row is completed", async () => {
    const { ctx, rows } = makeMockCtx([
      {
        _id: "id-1",
        event_id: EVENT_ID,
        processed_at: 500,
        status: "completed",
      },
    ]);

    const result = await callClaim(ctx);

    expect(result).toEqual({ state: "already_processed" });
    expect(rows).toHaveLength(1);
    expect(ctx.db.patch).not.toHaveBeenCalled();
  });

  it("records successful side effects and allows a retry to finalize only", async () => {
    const { ctx, rows } = makeMockCtx();
    expect(await callClaim(ctx)).toEqual({ state: "acquired" });
    await callMarkHandled(ctx);
    expect(rows[0].status).toBe("handled");
    expect(await callClaim(ctx)).toEqual({ state: "handler_completed" });
    await callFinalize(ctx);
    expect(rows[0].status).toBe("completed");
  });

  it("treats legacy rows without status as completed (back-compat)", async () => {
    const { ctx } = makeMockCtx([
      { _id: "id-1", event_id: EVENT_ID, processed_at: 500 },
    ]);

    const result = await callClaim(ctx);

    expect(result).toEqual({ state: "already_processed" });
  });

  it("returns claim_held when a recent pending claim exists", async () => {
    const recentClaimAt = 1_000_000 - 30_000;
    const { ctx, rows } = makeMockCtx([
      {
        _id: "id-1",
        event_id: EVENT_ID,
        processed_at: recentClaimAt,
        status: "pending",
        claimed_at: recentClaimAt,
      },
    ]);

    const result = await callClaim(ctx);

    expect(result).toEqual({ state: "claim_held" });
    expect(rows[0].claimed_at).toBe(recentClaimAt);
    expect(ctx.db.patch).toHaveBeenCalledWith("id-1", {
      source_id: "dp_123",
    });
  });

  it("takes over a stale pending claim and re-acquires it", async () => {
    const staleClaimAt = 1_000_000 - STALE_CLAIM_MS - 1;
    const { ctx, rows } = makeMockCtx([
      {
        _id: "id-1",
        event_id: EVENT_ID,
        source_id: "dp_123",
        processed_at: staleClaimAt,
        status: "pending",
        claimed_at: staleClaimAt,
        claim_token: "old_owner",
      },
    ]);

    const result = await callClaim(ctx);

    expect(result).toEqual({ state: "acquired" });
    expect(ctx.db.patch).toHaveBeenCalledWith("id-1", {
      status: "pending",
      claimed_at: 1_000_000,
      claim_token: "token_new",
    });
    expect(rows[0].claimed_at).toBe(1_000_000);
  });

  it("does not replay an old source-less pending delivery", async () => {
    const { ctx, rows } = makeMockCtx([
      {
        _id: "id-1",
        event_id: EVENT_ID,
        processed_at: 1_000_000 - STALE_CLAIM_MS - 1,
        status: "pending",
      },
    ]);

    expect(await callClaim(ctx)).toEqual({ state: "review_required" });
    expect(rows[0]).toMatchObject({
      status: "review_required",
      review_reason: "ambiguous_previous_attempt",
    });
  });

  it("does not replay a legacy pending claim that already has a source", async () => {
    const { ctx, rows } = makeMockCtx([
      {
        _id: "id-1",
        event_id: EVENT_ID,
        source_id: "dp_123",
        processed_at: 1_000_000 - STALE_CLAIM_MS - 1,
        status: "pending",
      },
    ]);

    expect(await callClaim(ctx)).toEqual({ state: "review_required" });
    expect(rows[0].status).toBe("review_required");
  });

  it("does not replay source-less pending after a first held retry adds its source", async () => {
    const { ctx, rows } = makeMockCtx([
      {
        _id: "id-1",
        event_id: EVENT_ID,
        processed_at: 1_000_000 - STALE_CLAIM_MS + 1,
        status: "pending",
      },
    ]);

    expect(await callClaim(ctx)).toEqual({ state: "claim_held" });
    expect(rows[0].source_id).toBe("dp_123");
    jest.spyOn(Date, "now").mockReturnValue(1_000_002);
    expect(await callClaim(ctx)).toEqual({ state: "review_required" });
  });

  it("does not replay customer cleanup when its completion record was lost", async () => {
    const { ctx, rows } = makeMockCtx([
      {
        _id: "id-1",
        event_id: EVENT_ID,
        source_id: "dp_123",
        processed_at: 1_000_000 - STALE_CLAIM_MS - 1,
        claimed_at: 1_000_000 - STALE_CLAIM_MS - 1,
        claim_token: "old_owner",
        status: "cleanup_started",
      },
    ]);

    expect(await callClaim(ctx)).toEqual({ state: "review_required" });
    expect(rows[0].status).toBe("review_required");
    await expect(callMarkHandled(ctx)).rejects.toThrow("superseded");
  });

  it("rejects an old owner's completion after a stale pre-cleanup takeover", async () => {
    const { ctx, rows } = makeMockCtx([
      {
        _id: "id-1",
        event_id: EVENT_ID,
        source_id: "dp_123",
        processed_at: 1_000_000 - STALE_CLAIM_MS - 1,
        claimed_at: 1_000_000 - STALE_CLAIM_MS - 1,
        claim_token: "old_owner",
        status: "pending",
      },
    ]);

    expect(await callClaim(ctx)).toEqual({ state: "acquired" });
    expect(rows[0].claim_token).toBe("token_new");
    const { markWebhookHandled } = await import("../extraUsage");
    await expect(
      (markWebhookHandled as any).handler(ctx, {
        serviceKey: SERVICE_KEY,
        eventId: EVENT_ID,
        claimToken: "old_owner",
      }),
    ).rejects.toThrow("superseded");
  });

  it("reclaims a pending claim exactly at the stale boundary", async () => {
    const boundaryClaimAt = 1_000_000 - STALE_CLAIM_MS;
    const { ctx } = makeMockCtx([
      {
        _id: "id-1",
        event_id: EVENT_ID,
        source_id: "dp_123",
        processed_at: boundaryClaimAt,
        status: "pending",
        claimed_at: boundaryClaimAt,
        claim_token: "old_owner",
      },
    ]);

    const result = await callClaim(ctx);

    // `now - claimedAt < STALE_CLAIM_MS` is false at equality → reclaimable.
    expect(result).toEqual({ state: "acquired" });
  });

  it("treats a pending claim 1ms before the stale boundary as still held", async () => {
    const justBeforeBoundary = 1_000_000 - (STALE_CLAIM_MS - 1);
    const { ctx } = makeMockCtx([
      {
        _id: "id-1",
        event_id: EVENT_ID,
        processed_at: justBeforeBoundary,
        status: "pending",
        claim_token: "old_owner",
        claimed_at: justBeforeBoundary,
      },
    ]);

    const result = await callClaim(ctx);

    expect(result).toEqual({ state: "claim_held" });
  });

  it("falls back to processed_at when claimed_at is missing on a pending row", async () => {
    const oldProcessedAt = 1_000_000 - STALE_CLAIM_MS - 1_000;
    const { ctx } = makeMockCtx([
      {
        _id: "id-1",
        event_id: EVENT_ID,
        source_id: "dp_123",
        processed_at: oldProcessedAt,
        status: "pending",
        claim_token: "old_owner",
      },
    ]);

    const result = await callClaim(ctx);

    expect(result).toEqual({ state: "acquired" });
  });
});

describe("markFraudCleanupStarted", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date, "now").mockReturnValue(1_000_000);
  });

  afterEach(() => jest.restoreAllMocks());

  it("records customer cleanup before external changes", async () => {
    const { ctx, rows } = makeMockCtx();
    await callClaim(ctx);
    const { markFraudCleanupStarted } = await import("../extraUsage");
    const result = await (markFraudCleanupStarted as any).handler(ctx, {
      serviceKey: SERVICE_KEY,
      eventId: EVENT_ID,
      claimToken: "token_new",
      customerId: "cus_shared",
    });

    expect(result).toEqual({ allowed: true });
    expect(rows[0]).toMatchObject({
      status: "cleanup_started",
      review_customer_id: "cus_shared",
    });
  });

  it("keeps a restored customer's Stripe resources for manual review", async () => {
    const { ctx, rows } = makeMockCtx();
    await callClaim(ctx);
    const originalQuery = ctx.db.query;
    ctx.db.query = jest.fn((table: string) =>
      table === "user_suspensions"
        ? {
            withIndex: (_name: string, predicate: any) => {
              const filters: Record<string, unknown> = {};
              const q = {
                eq: (field: string, value: unknown) => {
                  filters[field] = value;
                  return q;
                },
              };
              predicate(q);
              expect(filters).toEqual({
                stripe_customer_id: "cus_shared",
                status: "resolved",
              });
              return { first: async () => ({ _id: "restored_user" }) };
            },
          }
        : originalQuery(table),
    );
    const { markFraudCleanupStarted } = await import("../extraUsage");
    const result = await (markFraudCleanupStarted as any).handler(ctx, {
      serviceKey: SERVICE_KEY,
      eventId: EVENT_ID,
      claimToken: "token_new",
      customerId: "cus_shared",
    });

    expect(result).toEqual({ allowed: false });
    expect(rows[0].status).toBe("pending");
  });
});

describe("purgeOldProcessedWebhooks", () => {
  it("purges expired completed rows past a backlog of retained reviews", async () => {
    const rows = Array.from({ length: 101 }, (_, i) => ({
      _id: `review-${i}`,
      status: "review_required" as const,
      processed_at: 100,
    }));
    const allRows: Array<{
      _id: string;
      status?: string;
      processed_at: number;
    }> = [
      ...rows,
      { _id: "completed", status: "completed", processed_at: 100 },
    ];
    const ctx: any = {
      db: {
        query: () => ({
          order: () => ({
            take: async (count: number) => allRows.slice(0, count),
          }),
          withIndex: (_name: string, predicate: any) => {
            let status: string | undefined;
            let cutoff = Infinity;
            const q = {
              eq: (_field: string, value: string | undefined) => {
                status = value;
                return q;
              },
              lt: (_field: string, value: number) => {
                cutoff = value;
                return q;
              },
            };
            predicate(q);
            return {
              take: async (count: number) =>
                allRows
                  .filter(
                    (row) => row.status === status && row.processed_at < cutoff,
                  )
                  .slice(0, count),
            };
          },
        }),
        delete: jest.fn(async (id: string) => {
          const index = allRows.findIndex((row) => row._id === id);
          if (index >= 0) allRows.splice(index, 1);
        }),
      },
    };
    const { purgeOldProcessedWebhooks } = await import("../extraUsage");
    expect(
      await (purgeOldProcessedWebhooks as any).handler(ctx, {
        cutoffTimeMs: 1_000,
        limit: 100,
      }),
    ).toEqual({ deletedCount: 1 });
    expect(allRows).toHaveLength(101);
    expect(allRows.every((row) => row.status === "review_required")).toBe(true);
  });
});

describe("completeFraudWebhookReview", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date, "now").mockReturnValue(2_000_000);
  });
  afterEach(() => jest.restoreAllMocks());

  it("requires an explicit reviewer and records the reconciled outcome", async () => {
    const { ctx, rows } = makeMockCtx([
      {
        _id: "id-1",
        event_id: EVENT_ID,
        source_id: "dp_123",
        status: "review_required",
        processed_at: 1_000_000,
        review_reason: "ambiguous_previous_attempt",
      },
    ]);
    const { completeFraudWebhookReview } = await import("../extraUsage");
    await expect(callFinalize(ctx)).rejects.toThrow("manual reconciliation");
    await expect(
      (completeFraudWebhookReview as any).handler(ctx, {
        serviceKey: SERVICE_KEY,
        eventId: EVENT_ID,
        reviewedBy: " ",
        resolution: "cleanup_completed",
      }),
    ).rejects.toThrow("Reviewer identity");

    await (completeFraudWebhookReview as any).handler(ctx, {
      serviceKey: SERVICE_KEY,
      eventId: EVENT_ID,
      reviewedBy: "support-agent-id",
      resolution: "cleanup_completed",
    });
    expect(rows[0]).toMatchObject({
      status: "completed",
      review_resolution: "cleanup_completed",
      reviewed_by: "support-agent-id",
      reviewed_at: 2_000_000,
    });
    expect(await callClaim(ctx)).toEqual({ state: "already_processed" });
  });
});

describe("finalizeWebhookProcessing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date, "now").mockReturnValue(2_000_000);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("transitions a pending row to completed", async () => {
    const { ctx, rows } = makeMockCtx([
      {
        _id: "id-1",
        event_id: EVENT_ID,
        processed_at: 1_000_000,
        status: "pending",
        claimed_at: 1_000_000,
      },
    ]);

    const result = await callFinalize(ctx);

    expect(result).toBeNull();
    expect(rows[0]).toMatchObject({
      status: "completed",
      processed_at: 2_000_000,
    });
  });

  it("is idempotent — re-finalizing a completed row stays completed", async () => {
    const { ctx, rows } = makeMockCtx([
      {
        _id: "id-1",
        event_id: EVENT_ID,
        processed_at: 1_500_000,
        status: "completed",
      },
    ]);

    await callFinalize(ctx);

    expect(rows[0].status).toBe("completed");
    expect(rows[0].processed_at).toBe(2_000_000);
  });

  it("is a no-op when the row is missing (defensive)", async () => {
    const { ctx } = makeMockCtx();

    const result = await callFinalize(ctx);

    expect(result).toBeNull();
    expect(ctx.db.patch).not.toHaveBeenCalled();
  });
});
