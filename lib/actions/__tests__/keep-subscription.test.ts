import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { PAID_FUNNEL_EVENTS } from "@/lib/analytics/paid-funnel";

const mockListSubscriptions = jest.fn();
const mockUpdateSubscription = jest.fn();
const mockGetBillingActionContext = jest.fn();
const mockPostHogEvent = jest.fn();

function mockStripeSubscriptionsList(data: unknown[]) {
  mockListSubscriptions.mockReturnValue({
    async *[Symbol.asyncIterator]() {
      yield* data;
    },
  } as never);
}

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

jest.mock("@/lib/posthog/server", () => ({
  phLogger: {
    event: mockPostHogEvent,
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const mockConvexMutation = jest.fn();

jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({
    mutation: mockConvexMutation,
  }),
}));

jest.mock("@/convex/_generated/api", () => ({
  api: {
    subscriptionPauses: {
      cancelScheduledPause: "subscriptionPauses.cancelScheduledPause",
    },
  },
}));

describe("keepSubscriptionAction", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetBillingActionContext.mockResolvedValue({
      organizationId: "org_123",
      user: {
        id: "user_123",
      },
      stripeCustomerId: "cus_123",
    } as never);
  });

  it("removes scheduled cancellation from the active subscription", async () => {
    mockStripeSubscriptionsList([
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
    ]);
    mockUpdateSubscription.mockResolvedValue({
      id: "sub_123",
      cancel_at_period_end: false,
      current_period_end: 1_782_444_800,
    } as never);

    const { default: keepSubscriptionAction } =
      await import("../keep-subscription");

    await expect(keepSubscriptionAction()).resolves.toEqual({
      kept: true,
      cancelAtPeriodEnd: false,
      currentPeriodEnd: 1_782_444_800_000,
      alreadyKept: false,
    });

    expect(mockListSubscriptions).toHaveBeenCalledWith({
      customer: "cus_123",
      status: "all",
      limit: 100,
      expand: ["data.items.data.price"],
    });
    expect(mockUpdateSubscription).toHaveBeenCalledWith("sub_123", {
      cancel_at_period_end: false,
    });
    expect(mockPostHogEvent).toHaveBeenCalledWith(
      PAID_FUNNEL_EVENTS.cancellationReversed,
      expect.objectContaining({
        userId: "user_123",
        org_id: "org_123",
        subscription_tier: "pro",
        plan: "pro-monthly-plan",
        cancellation_reversal_type: "in_app",
        cancel_at_period_end: false,
        stripe_customer_id: "cus_123",
        stripe_subscription_id: "sub_123",
        stripe_price_id: "price_pro",
      }),
    );
  });

  it("returns success without updating Stripe when cancellation is already removed", async () => {
    mockStripeSubscriptionsList([
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
    ]);

    const { default: keepSubscriptionAction } =
      await import("../keep-subscription");

    await expect(keepSubscriptionAction()).resolves.toEqual({
      kept: true,
      cancelAtPeriodEnd: false,
      currentPeriodEnd: 1_782_444_800_000,
      alreadyKept: true,
    });

    expect(mockUpdateSubscription).not.toHaveBeenCalled();
    expect(mockPostHogEvent).not.toHaveBeenCalled();
  });

  it("throws when there is no active subscription to keep", async () => {
    mockStripeSubscriptionsList([
      {
        id: "sub_canceled",
        status: "canceled",
        cancel_at_period_end: false,
        items: { data: [] },
      },
    ]);

    const { default: keepSubscriptionAction } =
      await import("../keep-subscription");

    await expect(keepSubscriptionAction()).rejects.toThrow(
      "No active subscription found",
    );
    expect(mockUpdateSubscription).not.toHaveBeenCalled();
  });

  it("clears pause metadata and cancels the pause record when keeping a paused plan", async () => {
    process.env.CONVEX_SERVICE_ROLE_KEY = "service-key";
    mockConvexMutation.mockResolvedValue({ canceledCount: 1 } as never);
    mockStripeSubscriptionsList([
      {
        id: "sub_paused",
        status: "active",
        cancel_at_period_end: true,
        current_period_end: 1_782_444_800,
        metadata: {
          hackeraiPauseId: "pause_1",
          hackeraiPauseMonths: "2",
          hackeraiPauseResumeAt: "1795000000000",
          hackeraiPauseRequestedAt: "1780000000000",
        },
        items: {
          data: [
            {
              price: {
                id: "price_pro_plus",
                lookup_key: "pro-plus-monthly-plan",
              },
            },
          ],
        },
      },
    ]);
    mockUpdateSubscription.mockResolvedValue({
      id: "sub_paused",
      cancel_at_period_end: false,
      current_period_end: 1_782_444_800,
    } as never);

    const { default: keepSubscriptionAction } =
      await import("../keep-subscription");

    await expect(keepSubscriptionAction()).resolves.toEqual({
      kept: true,
      cancelAtPeriodEnd: false,
      currentPeriodEnd: 1_782_444_800_000,
      alreadyKept: false,
      pauseCanceled: true,
    });

    expect(mockUpdateSubscription).toHaveBeenCalledWith("sub_paused", {
      cancel_at_period_end: false,
      metadata: {
        hackeraiPauseId: "",
        hackeraiPauseMonths: "",
        hackeraiPauseResumeAt: "",
        hackeraiPauseRequestedAt: "",
      },
    });
    expect(mockConvexMutation).toHaveBeenCalledWith(
      "subscriptionPauses.cancelScheduledPause",
      expect.objectContaining({
        serviceKey: "service-key",
        stripeSubscriptionId: "sub_paused",
      }),
    );
    expect(mockPostHogEvent).toHaveBeenCalledWith(
      PAID_FUNNEL_EVENTS.subscriptionPauseCanceled,
      expect.objectContaining({
        pause_id: "pause_1",
        pause_months: 2,
        pause_record_canceled: true,
      }),
    );
    expect(mockPostHogEvent).toHaveBeenCalledWith(
      PAID_FUNNEL_EVENTS.cancellationReversed,
      expect.objectContaining({ retention_pause: true }),
    );
  });

  it("refuses to clear a pause when the Convex service key is missing", async () => {
    delete process.env.CONVEX_SERVICE_ROLE_KEY;
    mockStripeSubscriptionsList([
      {
        id: "sub_paused",
        status: "active",
        cancel_at_period_end: true,
        current_period_end: 1_782_444_800,
        metadata: {
          hackeraiPauseId: "pause_1",
          hackeraiPauseMonths: "1",
          hackeraiPauseResumeAt: "1795000000000",
        },
        items: {
          data: [
            { price: { id: "price_pro", lookup_key: "pro-monthly-plan" } },
          ],
        },
      },
    ]);

    const { default: keepSubscriptionAction } =
      await import("../keep-subscription");

    await expect(keepSubscriptionAction()).rejects.toThrow(
      "CONVEX_SERVICE_ROLE_KEY is not set",
    );
    expect(mockUpdateSubscription).not.toHaveBeenCalled();
  });
});
