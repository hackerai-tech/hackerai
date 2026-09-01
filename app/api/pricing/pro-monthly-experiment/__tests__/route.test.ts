import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockGetUserIDAndPro = jest.fn();
const mockEvaluatePricingExperiment = jest.fn();
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

jest.mock("@/lib/experiments/pro-monthly-pricing.server", () => ({
  evaluateProMonthlyPricingExperiment: mockEvaluatePricingExperiment,
}));

jest.mock("@/app/api/stripe", () => ({
  stripe: { prices: { list: mockListPrices } },
}));

const testAssignment = {
  key: "hac46-pro-monthly-29-pricing",
  variant: "test",
  priceLookupKey: "pro-monthly-plan-29-experiment",
  displayedAmountDollars: 29,
  currency: "usd",
  billingInterval: "month",
} as const;

function price(args: {
  id: string;
  lookupKey: string;
  amount: number;
  product?: string;
}) {
  return {
    id: args.id,
    active: true,
    lookup_key: args.lookupKey,
    unit_amount: args.amount,
    currency: "usd",
    type: "recurring",
    recurring: { interval: "month", interval_count: 1 },
    product: args.product ?? "prod_pro",
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

  it("returns the server-resolved Stripe Price ID for analytics", async () => {
    mockEvaluatePricingExperiment.mockResolvedValue(testAssignment);
    mockListPrices.mockResolvedValue({
      data: [
        price({
          id: "price_pro_29",
          lookupKey: "pro-monthly-plan-29-experiment",
          amount: 2_900,
        }),
        price({
          id: "price_pro_25",
          lookupKey: "pro-monthly-plan",
          amount: 2_500,
        }),
      ],
    } as never);

    const { GET } = await import("../route");
    const response = await GET({} as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ...testAssignment,
      stripePriceId: "price_pro_29",
    });
    expect(mockListPrices).toHaveBeenCalledWith({
      active: true,
      lookup_keys: ["pro-monthly-plan-29-experiment", "pro-monthly-plan"],
    });
  });

  it("fails closed when the experiment Price belongs to another Product", async () => {
    mockEvaluatePricingExperiment.mockResolvedValue(testAssignment);
    mockListPrices.mockResolvedValue({
      data: [
        price({
          id: "price_pro_29",
          lookupKey: "pro-monthly-plan-29-experiment",
          amount: 2_900,
          product: "prod_wrong",
        }),
        price({
          id: "price_pro_25",
          lookupKey: "pro-monthly-plan",
          amount: 2_500,
        }),
      ],
    } as never);

    const { GET } = await import("../route");
    const response = await GET({} as never);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Experimental subscription price is unavailable",
    });
  });

  it("does not query Stripe when the user has no experiment assignment", async () => {
    mockEvaluatePricingExperiment.mockResolvedValue(undefined);

    const { GET } = await import("../route");
    const response = await GET({} as never);

    expect(response.status).toBe(200);
    expect(mockListPrices).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      key: null,
      variant: null,
    });
  });
});
