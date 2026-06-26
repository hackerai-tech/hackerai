import { describe, expect, it, jest, beforeEach } from "@jest/globals";

const mockListSubscriptions = jest.fn();
const mockUpdateSubscription = jest.fn();
const mockGetBillingActionContext = jest.fn();
const mockPostHogEvent = jest.fn();

jest.mock("@/app/api/stripe", () => ({
  stripe: {
    subscriptions: {
      list: mockListSubscriptions,
      update: mockUpdateSubscription,
    },
  },
}));

jest.mock("@/lib/actions/billing-context", () => ({
  getBillingActionContext: mockGetBillingActionContext,
}));

jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: jest.fn(),
}));

jest.mock("@/lib/posthog/server", () => ({
  phLogger: {
    error: jest.fn(),
    warn: jest.fn(),
    event: mockPostHogEvent,
  },
}));

describe("cancelSubscriptionAction", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.CONVEX_SERVICE_ROLE_KEY;

    mockGetBillingActionContext.mockResolvedValue({
      organizationId: "org_123",
      user: {
        id: "user_123",
        createdAt: "2026-06-01T00:00:00.000Z",
      },
      stripeCustomerId: "cus_123",
    } as never);
  });

  it("returns success without updating Stripe when cancellation is already scheduled", async () => {
    mockListSubscriptions.mockResolvedValue({
      data: [
        {
          id: "sub_123",
          status: "active",
          cancel_at_period_end: true,
          current_period_end: 1_782_444_800,
          items: {
            data: [
              {
                price: {
                  id: "price_pro",
                  lookup_key: "pro-monthly-plan",
                },
              },
            ],
          },
        },
      ],
    } as never);

    const { default: cancelSubscriptionAction } =
      await import("../cancel-subscription");

    await expect(
      cancelSubscriptionAction({
        cancellationReason: {
          reasonCategory: "other",
          reasonDetails: "Already handled",
        },
      }),
    ).resolves.toEqual({
      canceled: true,
      cancelAtPeriodEnd: true,
      currentPeriodEnd: 1_782_444_800_000,
      alreadyScheduled: true,
    });

    expect(mockListSubscriptions).toHaveBeenCalledWith({
      customer: "cus_123",
      status: "all",
      limit: 10,
      expand: ["data.items.data.price"],
    });
    expect(mockUpdateSubscription).not.toHaveBeenCalled();
    expect(mockPostHogEvent).not.toHaveBeenCalled();
  });

  it("returns alreadyScheduled false after scheduling a new cancellation", async () => {
    mockListSubscriptions.mockResolvedValue({
      data: [
        {
          id: "sub_123",
          status: "active",
          cancel_at_period_end: false,
          current_period_end: 1_782_444_800,
          items: {
            data: [
              {
                price: {
                  id: "price_pro",
                  lookup_key: "pro-monthly-plan",
                },
              },
            ],
          },
        },
      ],
    } as never);
    mockUpdateSubscription.mockResolvedValue({
      id: "sub_123",
      cancel_at_period_end: true,
      current_period_end: 1_782_444_800,
      cancellation_details: {},
    } as never);

    const { default: cancelSubscriptionAction } =
      await import("../cancel-subscription");

    await expect(
      cancelSubscriptionAction({
        cancellationReason: {
          reasonCategory: "other",
          reasonDetails: "Done for now",
        },
      }),
    ).resolves.toEqual({
      canceled: true,
      cancelAtPeriodEnd: true,
      currentPeriodEnd: 1_782_444_800_000,
      alreadyScheduled: false,
    });

    expect(mockUpdateSubscription).toHaveBeenCalledWith("sub_123", {
      cancel_at_period_end: true,
      cancellation_details: {
        feedback: "other",
      },
    });
    expect(mockPostHogEvent).toHaveBeenCalledTimes(2);
  });
});
