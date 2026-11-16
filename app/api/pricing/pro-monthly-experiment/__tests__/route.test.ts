import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockGetUserIDAndPro = jest.fn();
const mockListPrices = jest.fn();

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

jest.mock("@/app/api/stripe", () => ({
  stripe: { prices: { list: mockListPrices } },
}));

function price(amount: number) {
  return {
    id: "price_pro_29",
    active: true,
    lookup_key: "pro-monthly-plan",
    unit_amount: amount,
    currency: "usd",
    billing_scheme: "per_unit",
    type: "recurring",
    recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
  };
}

describe("GET /api/pricing/pro-monthly-experiment", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserIDAndPro.mockResolvedValue({
      userId: "user_123",
      subscription: "free",
    } as never);
  });

  it("returns the verified $29 monthly Stripe Price for display", async () => {
    mockListPrices.mockResolvedValue({ data: [price(2900)] } as never);
    const { GET } = await import("../route");
    const response = await GET({} as never);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      priceLookupKey: "pro-monthly-plan",
      displayedAmountDollars: 29,
      currency: "usd",
      billingInterval: "month",
      stripePriceId: "price_pro_29",
    });
    expect(mockListPrices).toHaveBeenCalledWith({
      active: true,
      lookup_keys: ["pro-monthly-plan"],
    });
  });

  it("fails closed when the lookup key still points to $25", async () => {
    mockListPrices.mockResolvedValue({ data: [price(2500)] } as never);
    const { GET } = await import("../route");
    const response = await GET({} as never);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Pro monthly price is unavailable",
    });
  });

  it("fails closed when the Price is unavailable", async () => {
    mockListPrices.mockResolvedValue({ data: [] } as never);
    const { GET } = await import("../route");
    const response = await GET({} as never);
    expect(response.status).toBe(503);
  });
});
