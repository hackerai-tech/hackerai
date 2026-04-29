import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";

jest.mock("../_generated/server", () => ({
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
  processed_at: number;
  status?: "pending" | "completed";
  claimed_at?: number;
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
          predicate({
            eq: (_field: string, value: string) => {
              captured = value;
              return {};
            },
          });
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
  });
}

async function callFinalize(ctx: any) {
  const { finalizeWebhookProcessing } = await import("../extraUsage");
  return (finalizeWebhookProcessing as any).handler(ctx, {
    serviceKey: SERVICE_KEY,
    eventId: EVENT_ID,
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
      status: "pending",
      claimed_at: 1_000_000,
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
    expect(ctx.db.patch).not.toHaveBeenCalled();
  });

  it("takes over a stale pending claim and re-acquires it", async () => {
    const staleClaimAt = 1_000_000 - STALE_CLAIM_MS - 1;
    const { ctx, rows } = makeMockCtx([
      {
        _id: "id-1",
        event_id: EVENT_ID,
        processed_at: staleClaimAt,
        status: "pending",
        claimed_at: staleClaimAt,
      },
    ]);

    const result = await callClaim(ctx);

    expect(result).toEqual({ state: "acquired" });
    expect(ctx.db.patch).toHaveBeenCalledWith("id-1", {
      status: "pending",
      claimed_at: 1_000_000,
    });
    expect(rows[0].claimed_at).toBe(1_000_000);
  });

  it("reclaims a pending claim exactly at the stale boundary", async () => {
    const boundaryClaimAt = 1_000_000 - STALE_CLAIM_MS;
    const { ctx } = makeMockCtx([
      {
        _id: "id-1",
        event_id: EVENT_ID,
        processed_at: boundaryClaimAt,
        status: "pending",
        claimed_at: boundaryClaimAt,
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
        processed_at: oldProcessedAt,
        status: "pending",
      },
    ]);

    const result = await callClaim(ctx);

    expect(result).toEqual({ state: "acquired" });
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
