import { describe, it, expect, jest } from "@jest/globals";

jest.mock("convex/values", () => ({
  ConvexError: class ConvexError extends Error {
    data: any;
    constructor(data: any) {
      super(typeof data === "string" ? data : data.message);
      this.data = data;
      this.name = "ConvexError";
    }
  },
}));

type SuspensionRow = {
  _id: string;
  user_id: string;
  status: "active" | "resolved";
  category:
    | "early_fraud_warning"
    | "dispute_fraudulent"
    | "dispute_billing_hold";
  source: "stripe";
  source_id: string;
  stripe_customer_id: string;
  created_at: number;
  updated_at: number;
  source_created_at?: number;
};

const makeSuspension = (
  overrides: Partial<SuspensionRow> = {},
): SuspensionRow => ({
  _id: "suspension-1",
  user_id: "user_123",
  status: "active",
  category: "dispute_fraudulent",
  source: "stripe",
  source_id: "dp_123",
  stripe_customer_id: "cus_123",
  created_at: 1_000,
  updated_at: 1_000,
  source_created_at: 1_000,
  ...overrides,
});

function makeMockCtx(rows: SuspensionRow[]) {
  const withIndex = jest.fn((_indexName: string, predicate: any) => {
    const filters: Record<string, unknown> = {};
    const q = {
      eq: jest.fn((field: string, value: unknown) => {
        filters[field] = value;
        return q;
      }),
    };
    predicate(q);

    const filteredRows = () =>
      rows.filter((row) =>
        Object.entries(filters).every(
          ([field, value]) => row[field as keyof SuspensionRow] === value,
        ),
      );

    return {
      order: jest.fn((direction: "asc" | "desc") => ({
        collect: async () => {
          const sorted = [...filteredRows()].sort(
            (a, b) => (a.source_created_at ?? 0) - (b.source_created_at ?? 0),
          );
          return direction === "desc" ? sorted.reverse() : sorted;
        },
      })),
    };
  });

  return {
    ctx: {
      __withIndex: withIndex,
      db: {
        query: jest.fn(() => ({ withIndex })),
      },
    } as any,
    withIndex,
  };
}

describe("suspensionGuards", () => {
  it("allows chat history when the user has no active fraud dispute", async () => {
    const { assertUserCanAccessChatHistory } =
      await import("../lib/suspensionGuards");
    const { ctx, withIndex } = makeMockCtx([
      makeSuspension({
        status: "active",
        category: "dispute_billing_hold",
        source_id: "dp_billing",
      }),
      makeSuspension({
        status: "resolved",
        category: "dispute_fraudulent",
        source_id: "dp_resolved",
      }),
    ]);

    await expect(
      assertUserCanAccessChatHistory(ctx, "user_123"),
    ).resolves.toBeUndefined();
    expect(withIndex).toHaveBeenCalledWith(
      "by_user_status_source_created",
      expect.any(Function),
    );
  });

  it("blocks chat history for any active fraudulent dispute", async () => {
    const { assertUserCanAccessChatHistory } =
      await import("../lib/suspensionGuards");
    const { ctx } = makeMockCtx([
      makeSuspension({
        _id: "suspension-newer",
        category: "dispute_billing_hold",
        source_id: "dp_billing_newer",
        source_created_at: 2_000,
      }),
      makeSuspension({
        _id: "suspension-fraud",
        category: "dispute_fraudulent",
        source_id: "dp_fraud",
        source_created_at: 1_000,
      }),
    ]);

    await expect(
      assertUserCanAccessChatHistory(ctx, "user_123"),
    ).rejects.toMatchObject({
      data: expect.objectContaining({
        code: "CHAT_ACCESS_SUSPENDED",
        message: expect.stringContaining("fraudulent payment dispute"),
        suspensionCategory: "dispute_fraudulent",
        suspensionSource: "stripe",
      }),
    });
  });

  it("reports whether public shared chat reads should be blocked", async () => {
    const { isUserBlockedByActiveFraudDispute } =
      await import("../lib/suspensionGuards");
    const blocked = makeMockCtx([makeSuspension()]);
    const allowed = makeMockCtx([
      makeSuspension({ category: "early_fraud_warning" }),
    ]);

    await expect(
      isUserBlockedByActiveFraudDispute(blocked.ctx, "user_123"),
    ).resolves.toBe(true);
    await expect(
      isUserBlockedByActiveFraudDispute(allowed.ctx, "user_123"),
    ).resolves.toBe(false);
  });
});
