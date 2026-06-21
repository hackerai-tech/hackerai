import { describe, it, expect, jest, beforeEach } from "@jest/globals";

jest.mock("../_generated/server", () => ({
  internalQuery: jest.fn((config: any) => config),
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

function buildDetailsQuery(rows: Record<string, any>[]) {
  let matches = [...rows];
  const query: any = {
    withIndex: jest.fn((_indexName: string, builder: any) => {
      const gtes: Record<string, number> = {};
      const ltes: Record<string, number> = {};
      const captureQuery = {
        gte: (field: string, value: number) => {
          gtes[field] = value;
          return captureQuery;
        },
        lte: (field: string, value: number) => {
          ltes[field] = value;
          return captureQuery;
        },
      };
      builder(captureQuery);
      matches = rows.filter((row) => {
        const afterStart =
          gtes.created_at === undefined || row.created_at >= gtes.created_at;
        const beforeEnd =
          ltes.created_at === undefined || row.created_at <= ltes.created_at;
        return afterStart && beforeEnd;
      });
      return query;
    }),
    order: jest.fn<any>((direction: "asc" | "desc") => {
      matches = [...matches].sort((a, b) =>
        direction === "desc"
          ? b.created_at - a.created_at
          : a.created_at - b.created_at,
      );
      return query;
    }),
    take: jest.fn<any>(async (limit: number) => matches.slice(0, limit)),
  };
  return query;
}

describe("cancellation reason feedback export", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("exports joined cancellation feedback through an internal query without sensitive ids", async () => {
    const detailRows = [
      {
        _id: "detail-1",
        cancellation_reason_id: "reason-1",
        user_id: "user-1",
        organization_id: "org-1",
        stripe_subscription_id: "sub-1",
        reason_details: "Agent was useful, but too expensive right now.",
        created_at: Date.UTC(2026, 5, 21, 12),
      },
      {
        _id: "detail-2",
        cancellation_reason_id: "reason-2",
        user_id: "user-2",
        reason_details: "Outside filter window",
        created_at: Date.UTC(2026, 5, 19, 12),
      },
    ];
    const detailsQuery = buildDetailsQuery(detailRows);
    const reasonRows: Record<string, any> = {
      "reason-1": {
        _id: "reason-1",
        user_id: "user-1",
        organization_id: "org-1",
        stripe_customer_id: "cus-1",
        stripe_subscription_id: "sub-1",
        stripe_price_id: "price-1",
        plan: "pro",
        subscription_tier: "pro",
        reason_category: "too_expensive",
        status: "started",
        source: "in_app",
        recent_usage_segment: "moderate",
        recent_usage_request_count: 24,
        recent_usage_cost_dollars: 12.5,
      },
    };
    const ctx: any = {
      db: {
        query: jest.fn((table: string) => {
          if (table !== "cancellation_reason_details") {
            throw new Error(`unexpected table: ${table}`);
          }
          return detailsQuery;
        }),
        get: jest.fn(async (id: string) => reasonRows[id] ?? null),
      },
    };

    const { getCancellationFeedbackForAnalysis } =
      await import("../cancellationReasons");
    const result = await (getCancellationFeedbackForAnalysis as any).handler(
      ctx,
      {
        limit: 50,
        startAt: Date.UTC(2026, 5, 20),
      },
    );

    expect(detailsQuery.withIndex).toHaveBeenCalledWith(
      "by_created_at",
      expect.any(Function),
    );
    expect(detailsQuery.order).toHaveBeenCalledWith("desc");
    expect(detailsQuery.take).toHaveBeenCalledWith(50);
    expect(ctx.db.get).toHaveBeenCalledWith("reason-1");
    expect(ctx.db.get).not.toHaveBeenCalledWith("reason-2");
    expect(result).toEqual([
      {
        createdAt: "2026-06-21T12:00:00.000Z",
        reasonCategory: "too_expensive",
        subscriptionTier: "pro",
        plan: "pro",
        status: "started",
        source: "in_app",
        recentUsageSegment: "moderate",
        recentUsageRequestCount: 24,
        recentUsageCostDollars: 12.5,
        feedback: "Agent was useful, but too expensive right now.",
      },
    ]);
    expect(result[0]).not.toHaveProperty("user_id");
    expect(result[0]).not.toHaveProperty("organization_id");
    expect(result[0]).not.toHaveProperty("stripe_customer_id");
    expect(result[0]).not.toHaveProperty("stripe_subscription_id");
  });

  it("caps dashboard export size", async () => {
    const detailsQuery = buildDetailsQuery([]);
    const ctx: any = {
      db: {
        query: jest.fn(() => detailsQuery),
        get: jest.fn(),
      },
    };

    const { getCancellationFeedbackForAnalysis } =
      await import("../cancellationReasons");
    await (getCancellationFeedbackForAnalysis as any).handler(ctx, {
      limit: 50_000,
    });

    expect(detailsQuery.take).toHaveBeenCalledWith(10_000);
  });

  it("filters by creation date before applying the dashboard export limit", async () => {
    const inWindowCreatedAt = Date.UTC(2026, 5, 20, 12);
    const detailsQuery = buildDetailsQuery([
      {
        _id: "newer-out-of-window",
        cancellation_reason_id: "newer-reason",
        reason_details: "Too new for the requested window",
        created_at: Date.UTC(2026, 5, 22, 12),
      },
      {
        _id: "older-in-window",
        cancellation_reason_id: "in-window-reason",
        reason_details: "Missing the workflow I needed.",
        created_at: inWindowCreatedAt,
      },
      {
        _id: "oldest-in-window",
        cancellation_reason_id: "oldest-reason",
        reason_details: "Also in window but beyond limit",
        created_at: Date.UTC(2026, 5, 19, 12),
      },
    ]);
    const ctx: any = {
      db: {
        query: jest.fn(() => detailsQuery),
        get: jest.fn(async (id: string) =>
          id === "in-window-reason"
            ? {
                reason_category: "missing_feature",
                subscription_tier: "pro-plus",
                plan: "pro-plus",
                status: "started",
                source: "in_app",
                recent_usage_segment: "light",
                recent_usage_request_count: 3,
                recent_usage_cost_dollars: 1.25,
              }
            : null,
        ),
      },
    };

    const { getCancellationFeedbackForAnalysis } =
      await import("../cancellationReasons");
    const result = await (getCancellationFeedbackForAnalysis as any).handler(
      ctx,
      {
        limit: 1,
        startAt: Date.UTC(2026, 5, 19),
        endAt: Date.UTC(2026, 5, 20, 23, 59, 59),
      },
    );

    expect(detailsQuery.take).toHaveBeenCalledWith(1);
    expect(ctx.db.get).toHaveBeenCalledWith("in-window-reason");
    expect(ctx.db.get).not.toHaveBeenCalledWith("newer-reason");
    expect(result).toEqual([
      {
        createdAt: new Date(inWindowCreatedAt).toISOString(),
        reasonCategory: "missing_feature",
        subscriptionTier: "pro-plus",
        plan: "pro-plus",
        status: "started",
        source: "in_app",
        recentUsageSegment: "light",
        recentUsageRequestCount: 3,
        recentUsageCostDollars: 1.25,
        feedback: "Missing the workflow I needed.",
      },
    ]);
  });
});
