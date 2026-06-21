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
  return {
    order: jest.fn<any>().mockReturnThis(),
    take: jest.fn<any>().mockResolvedValue(rows),
  };
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
});
