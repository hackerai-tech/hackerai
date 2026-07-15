import {
  describe,
  expect,
  it,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { PAID_FUNNEL_EVENTS } from "@/lib/analytics/paid-funnel";

const mockListSubscriptions = jest.fn();
const mockUpdateSubscription = jest.fn();
const mockCancelSubscription = jest.fn();
const mockGetBillingActionContext = jest.fn();
const mockPostHogEvent = jest.fn();
const mockPostHogError = jest.fn();
const mockConvexMutation = jest.fn();
const mockGetConvexClient = jest.fn();

jest.mock("@/app/api/stripe", () => ({
  stripe: {
    subscriptions: {
      list: mockListSubscriptions,
      update: mockUpdateSubscription,
      cancel: mockCancelSubscription,
    },
  },
}));

jest.mock("@/lib/actions/billing-context", () => ({
  getBillingActionContext: mockGetBillingActionContext,
}));

jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: mockGetConvexClient,
}));

jest.mock("@/lib/posthog/server", () => ({
  phLogger: {
    error: mockPostHogError,
    warn: jest.fn(),
    event: mockPostHogEvent,
  },
}));

describe("cancelSubscriptionAction", () => {
  const originalConvexServiceRoleKey = process.env.CONVEX_SERVICE_ROLE_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.CONVEX_SERVICE_ROLE_KEY;
    mockGetConvexClient.mockReturnValue({
      mutation: mockConvexMutation,
    } as never);

    mockGetBillingActionContext.mockResolvedValue({
      organizationId: "org_123",
      user: {
        id: "user_123",
        createdAt: "2026-06-01T00:00:00.000Z",
      },
      stripeCustomerId: "cus_123",
    } as never);
  });

  afterEach(() => {
    if (originalConvexServiceRoleKey === undefined) {
      delete process.env.CONVEX_SERVICE_ROLE_KEY;
    } else {
      process.env.CONVEX_SERVICE_ROLE_KEY = originalConvexServiceRoleKey;
    }
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
    expect(mockPostHogEvent).toHaveBeenNthCalledWith(
      1,
      PAID_FUNNEL_EVENTS.cancellationReasonSubmitted,
      expect.any(Object),
    );
    expect(mockPostHogEvent).toHaveBeenNthCalledWith(
      2,
      PAID_FUNNEL_EVENTS.cancellationCompleted,
      expect.any(Object),
    );
  });

  it("cancels a past-due subscription immediately to stop payment retries", async () => {
    mockListSubscriptions.mockResolvedValue({
      data: [
        {
          id: "sub_past_due",
          status: "past_due",
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
    mockCancelSubscription.mockResolvedValue({
      id: "sub_past_due",
      status: "canceled",
      cancel_at_period_end: false,
      canceled_at: 1_752_537_600,
      cancellation_details: {},
    } as never);

    const { default: cancelSubscriptionAction } =
      await import("../cancel-subscription");

    await expect(
      cancelSubscriptionAction({
        cancellationReason: {
          reasonCategory: "too_expensive",
          reasonDetails: "The renewal payment failed",
        },
      }),
    ).resolves.toEqual({
      canceled: true,
      cancelAtPeriodEnd: false,
      alreadyScheduled: false,
    });

    expect(mockCancelSubscription).toHaveBeenCalledWith("sub_past_due", {
      cancellation_details: {
        feedback: "too_expensive",
      },
      invoice_now: false,
      prorate: false,
    });
    expect(mockUpdateSubscription).not.toHaveBeenCalled();
    expect(mockPostHogEvent).toHaveBeenNthCalledWith(
      2,
      PAID_FUNNEL_EVENTS.cancellationCompleted,
      expect.objectContaining({
        cancellation_completion_type: "immediate_in_app",
        cancel_at_period_end: false,
      }),
    );
  });

  it("does not emit a duplicate completion event when the webhook completes first", async () => {
    process.env.CONVEX_SERVICE_ROLE_KEY = "service_key";
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
    mockConvexMutation
      .mockResolvedValueOnce("reason_123" as never)
      .mockResolvedValueOnce({ matchedCount: 1, updatedCount: 0 } as never);

    const { default: cancelSubscriptionAction } =
      await import("../cancel-subscription");

    await cancelSubscriptionAction({
      cancellationReason: {
        reasonCategory: "other",
        reasonDetails: "Done for now",
      },
    });

    expect(mockPostHogEvent).toHaveBeenCalledTimes(1);
    expect(mockPostHogEvent).toHaveBeenCalledWith(
      PAID_FUNNEL_EVENTS.cancellationReasonSubmitted,
      expect.any(Object),
    );
  });

  it("keeps fallback completion analytics when the completion mutation fails", async () => {
    process.env.CONVEX_SERVICE_ROLE_KEY = "service_key";
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
    mockConvexMutation
      .mockResolvedValueOnce("reason_123" as never)
      .mockRejectedValueOnce(new Error("Convex unavailable") as never);

    const { default: cancelSubscriptionAction } =
      await import("../cancel-subscription");

    await cancelSubscriptionAction({
      cancellationReason: {
        reasonCategory: "other",
        reasonDetails: "Done for now",
      },
    });

    expect(mockPostHogEvent).toHaveBeenNthCalledWith(
      2,
      PAID_FUNNEL_EVENTS.cancellationCompleted,
      expect.any(Object),
    );
  });

  it("logs the action stage when Stripe cancellation update fails", async () => {
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
    const error = new Error("Stripe unavailable");
    mockUpdateSubscription.mockRejectedValue(error as never);

    const { default: cancelSubscriptionAction } =
      await import("../cancel-subscription");

    await expect(
      cancelSubscriptionAction({
        cancellationReason: {
          reasonCategory: "other",
          reasonDetails: "Done for now",
        },
      }),
    ).rejects.toThrow("Stripe unavailable");

    expect(mockPostHogError).toHaveBeenCalledWith(
      "billing_subscription_cancellation_action_failed",
      expect.objectContaining({
        event: "billing_subscription_cancellation_action_failed",
        stage: "stripe_subscription_update",
        userId: "user_123",
        org_id: "org_123",
        stripe_customer_id: "cus_123",
        stripe_subscription_id: "sub_123",
        error,
      }),
    );
  });

  it("does not log expected billing context failures", async () => {
    const error = new Error("User not authenticated");
    mockGetBillingActionContext.mockRejectedValue(error as never);

    const { default: cancelSubscriptionAction } =
      await import("../cancel-subscription");

    await expect(
      cancelSubscriptionAction({
        cancellationReason: {
          reasonCategory: "other",
          reasonDetails: "Done for now",
        },
      }),
    ).rejects.toThrow("User not authenticated");

    expect(mockListSubscriptions).not.toHaveBeenCalled();
    expect(mockPostHogError).not.toHaveBeenCalled();
  });

  it("does not log when there is no active subscription to cancel", async () => {
    mockListSubscriptions.mockResolvedValue({
      data: [
        {
          id: "sub_canceled",
          status: "canceled",
          cancel_at_period_end: false,
          items: { data: [] },
        },
      ],
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
    ).rejects.toThrow("No active subscription found");

    expect(mockPostHogError).not.toHaveBeenCalledWith(
      "billing_subscription_cancellation_action_failed",
      expect.anything(),
    );
  });

  it("logs the action stage when Stripe subscription lookup fails", async () => {
    const error = new Error("Stripe unavailable");
    mockListSubscriptions.mockRejectedValue(error as never);

    const { default: cancelSubscriptionAction } =
      await import("../cancel-subscription");

    await expect(
      cancelSubscriptionAction({
        cancellationReason: {
          reasonCategory: "other",
          reasonDetails: "Done for now",
        },
      }),
    ).rejects.toThrow("Stripe unavailable");

    expect(mockPostHogError).toHaveBeenCalledWith(
      "billing_subscription_cancellation_action_failed",
      expect.objectContaining({
        event: "billing_subscription_cancellation_action_failed",
        stage: "stripe_subscription_lookup",
        userId: "user_123",
        org_id: "org_123",
        stripe_customer_id: "cus_123",
        error,
      }),
    );
  });
});
