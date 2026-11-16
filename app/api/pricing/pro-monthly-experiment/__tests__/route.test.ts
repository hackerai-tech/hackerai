import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockGetUserIDAndPro = jest.fn();
const mockResolveProMonthlyQuote = jest.fn();

jest.mock("next/server", () => ({
  NextResponse: {
    json: jest.fn((body: unknown, init?: ResponseInit) => ({
      status: init?.status ?? 200,
      headers: init?.headers,
      json: async () => body,
    })),
  },
}));

jest.mock("@/lib/auth/get-user-id", () => ({
  getUserIDAndPro: mockGetUserIDAndPro,
}));

jest.mock("@/lib/experiments/pro-monthly-pricing-hac248.server", () => ({
  resolveProMonthlyQuote: mockResolveProMonthlyQuote,
}));

const controlPrice = {
  priceLookupKey: "pro-monthly-plan",
  displayedAmountDollars: 29,
  currency: "usd",
  billingInterval: "month",
  stripePriceId: "price_pro_29",
};

describe("GET /api/pricing/pro-monthly-experiment", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserIDAndPro.mockResolvedValue({
      userId: "user_123",
      subscription: "free",
    } as never);
  });

  it("resolves the authenticated account's quote and may enroll it", async () => {
    mockResolveProMonthlyQuote.mockResolvedValue({
      price: controlPrice,
      stripePrice: { id: "price_pro_29" },
    } as never);
    const { GET } = await import("../route");
    const response = await GET({} as never);

    expect(response.status).toBe(200);
    expect(response.headers).toEqual({
      "Cache-Control": "private, no-store, max-age=0",
    });
    // Only the display quote is returned, never the raw Stripe object.
    await expect(response.json()).resolves.toEqual(controlPrice);
    expect(mockResolveProMonthlyQuote).toHaveBeenCalledWith({
      userId: "user_123",
      subscription: "free",
      enroll: true,
    });
  });

  it("returns an assigned account's $49 quote with its assignment", async () => {
    const assignment = {
      version: 1,
      key: "hac248-pro-monthly-49-pricing",
      variant: "test",
      priceLookupKey: "pro-monthly-plan-49-hac248",
      displayedAmountDollars: 49,
      stripePriceId: "price_pro_49",
      assignedAt: "2026-11-20T10:00:00.000Z",
    };
    const price = {
      ...controlPrice,
      priceLookupKey: "pro-monthly-plan-49-hac248",
      displayedAmountDollars: 49,
      stripePriceId: "price_pro_49",
    };
    mockResolveProMonthlyQuote.mockResolvedValue({
      price,
      assignment,
      stripePrice: { id: "price_pro_49" },
    } as never);
    const { GET } = await import("../route");
    const response = await GET({} as never);
    await expect(response.json()).resolves.toEqual({ ...price, assignment });
  });

  it("fails closed when no authoritative price is available", async () => {
    mockResolveProMonthlyQuote.mockRejectedValue(
      new Error("storage unavailable") as never,
    );
    const { GET } = await import("../route");
    const response = await GET({} as never);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Pro monthly price is unavailable",
    });
  });
});
