import { describe, expect, it, jest, beforeEach } from "@jest/globals";

const mockListSubscriptions = jest.fn();
const mockGetBillingActionContext = jest.fn();

jest.mock("@/app/api/stripe", () => ({
  stripe: {
    subscriptions: {
      list: mockListSubscriptions,
    },
  },
}));

jest.mock("@/lib/actions/billing-context", () => ({
  getBillingActionContext: mockGetBillingActionContext,
}));

describe("getSubscriptionCancellationStatusAction", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetBillingActionContext.mockResolvedValue({
      stripeCustomerId: "cus_123",
    } as never);
  });

  it("returns scheduled cancellation status for active subscriptions", async () => {
    mockListSubscriptions.mockResolvedValue({
      data: [
        {
          id: "sub_123",
          status: "active",
          cancel_at_period_end: true,
          current_period_end: 1_782_444_800,
        },
      ],
    } as never);

    const { default: getSubscriptionCancellationStatusAction } =
      await import("../subscription-status");

    await expect(getSubscriptionCancellationStatusAction()).resolves.toEqual({
      hasActiveSubscription: true,
      cancelAtPeriodEnd: true,
      currentPeriodEnd: 1_782_444_800_000,
    });
    expect(mockListSubscriptions).toHaveBeenCalledWith({
      customer: "cus_123",
      status: "all",
      limit: 10,
    });
  });

  it("returns an inactive status when Stripe has no current subscription", async () => {
    mockListSubscriptions.mockResolvedValue({
      data: [
        {
          id: "sub_canceled",
          status: "canceled",
          cancel_at_period_end: false,
        },
      ],
    } as never);

    const { default: getSubscriptionCancellationStatusAction } =
      await import("../subscription-status");

    await expect(getSubscriptionCancellationStatusAction()).resolves.toEqual({
      hasActiveSubscription: false,
      cancelAtPeriodEnd: false,
    });
  });
});
