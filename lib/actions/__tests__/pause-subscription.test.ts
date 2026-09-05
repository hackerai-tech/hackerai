import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { PAID_FUNNEL_EVENTS } from "@/lib/analytics/paid-funnel";
import { BILLING_ERRORS } from "@/lib/billing/billing-errors";

const mockListSubscriptions = jest.fn();
const mockUpdateSubscription = jest.fn();
const mockGetBillingActionContext = jest.fn();
const mockConvexMutation = jest.fn();
const mockConvexQuery = jest.fn();
const mockIsPauseOfferEnabledForUser = jest.fn();
const mockPostHogEvent = jest.fn();
const mockPostHogWarn = jest.fn();
const mockPostHogError = jest.fn();

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
  getConvexClient: () => ({
    mutation: mockConvexMutation,
    query: mockConvexQuery,
  }),
}));

jest.mock("@/convex/_generated/api", () => ({
  api: {
    cancellationReasons: {
      recordCancellationStarted:
        "cancellationReasons.recordCancellationStarted",
      recordRetentionOfferAccepted:
        "cancellationReasons.recordRetentionOfferAccepted",
    },
    subscriptionPauses: {
      getLatestPauseForUser: "subscriptionPauses.getLatestPauseForUser",
      recordScheduledPause: "subscriptionPauses.recordScheduledPause",
      cancelScheduledPause: "subscriptionPauses.cancelScheduledPause",
    },
  },
}));

jest.mock("@/lib/billing/retention-offers.server", () => ({
  isPauseOfferEnabledForUser: mockIsPauseOfferEnabledForUser,
  getPauseOfferFlagState: async (userId: string) =>
    (await mockIsPauseOfferEnabledForUser(userId)) ? "enabled" : "disabled",
}));

jest.mock("@/lib/posthog/server", () => ({
  phLogger: {
    event: mockPostHogEvent,
    warn: mockPostHogWarn,
    error: mockPostHogError,
    info: jest.fn(),
  },
}));

const PERIOD_END_SECONDS = 1_790_000_000;

function proPlusSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub_123",
    status: "active",
    cancel_at_period_end: false,
    metadata: { checkoutAttemptId: "ca_1" },
    default_payment_method: "pm_123",
    latest_invoice: "in_123",
    items: {
      data: [
        {
          quantity: 1,
          current_period_end: PERIOD_END_SECONDS,
          price: {
            id: "price_pro_plus",
            lookup_key: "pro-plus-monthly-plan",
            unit_amount: 6000,
            currency: "usd",
            recurring: { interval: "month", interval_count: 1 },
          },
        },
      ],
    },
    ...overrides,
  };
}

const validInput = {
  months: 2,
  cancellationReason: {
    reasonCategory: "not_using_enough",
    reasonSubcategory: "too_expensive_low_frequency",
    reasonDetails: "Busy for a couple of months",
  },
};

describe("pauseSubscriptionAction", () => {
  const originalServiceKey = process.env.CONVEX_SERVICE_ROLE_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CONVEX_SERVICE_ROLE_KEY = "service-key";
    mockGetBillingActionContext.mockResolvedValue({
      organizationId: "org_123",
      user: { id: "user_123", createdAt: "2026-06-01T00:00:00.000Z" },
      stripeCustomerId: "cus_123",
    } as never);
    mockIsPauseOfferEnabledForUser.mockResolvedValue(true as never);
    mockConvexQuery.mockResolvedValue(null as never);
    mockConvexMutation.mockImplementation((async (name: string) => {
      if (name === "cancellationReasons.recordCancellationStarted") {
        return "reason_1";
      }
      if (name === "subscriptionPauses.recordScheduledPause") {
        return { pauseId: "pause_1", created: true };
      }
      if (name === "subscriptionPauses.cancelScheduledPause") {
        return { canceledCount: 1 };
      }
      return null;
    }) as never);
    mockListSubscriptions.mockResolvedValue({
      data: [proPlusSubscription()],
    } as never);
    mockUpdateSubscription.mockImplementation((async (
      _id: string,
      params: Record<string, unknown>,
    ) => ({
      ...proPlusSubscription(),
      cancel_at_period_end: true,
      metadata: params.metadata,
    })) as never);
  });

  afterEach(() => {
    if (originalServiceKey === undefined) {
      delete process.env.CONVEX_SERVICE_ROLE_KEY;
    } else {
      process.env.CONVEX_SERVICE_ROLE_KEY = originalServiceKey;
    }
  });

  it("schedules the cancellation, stores the pause, and tags Stripe metadata", async () => {
    const { default: pauseSubscriptionAction } =
      await import("../pause-subscription");

    const result = await pauseSubscriptionAction(validInput);

    const pauseEffectiveAt = PERIOD_END_SECONDS * 1000;
    expect(result).toEqual({
      paused: true,
      months: 2,
      pauseEffectiveAt,
      resumeAt: expect.any(Number),
      alreadyScheduled: false,
    });
    expect(new Date(result.resumeAt).getUTCMonth()).toBe(
      (new Date(pauseEffectiveAt).getUTCMonth() + 2) % 12,
    );

    expect(mockConvexMutation).toHaveBeenCalledWith(
      "subscriptionPauses.recordScheduledPause",
      expect.objectContaining({
        serviceKey: "service-key",
        userId: "user_123",
        stripeSubscriptionId: "sub_123",
        stripePriceId: "price_pro_plus",
        stripePaymentMethodId: "pm_123",
        pauseMonths: 2,
        pauseEffectiveAt,
        resumeAt: result.resumeAt,
      }),
    );
    expect(mockUpdateSubscription).toHaveBeenCalledWith(
      "sub_123",
      expect.objectContaining({
        cancel_at_period_end: true,
        cancellation_details: {
          feedback: "unused",
          comment: "Paused for 2 months via HackerAI retention offer",
        },
        metadata: expect.objectContaining({
          checkoutAttemptId: "ca_1",
          hackeraiPauseId: "pause_1",
          hackeraiPauseMonths: "2",
          hackeraiPauseResumeAt: String(result.resumeAt),
        }),
      }),
    );
    expect(mockConvexMutation).toHaveBeenCalledWith(
      "cancellationReasons.recordRetentionOfferAccepted",
      expect.objectContaining({
        cancellationReasonId: "reason_1",
        retentionOffer: "pause",
      }),
    );
    expect(mockPostHogEvent).toHaveBeenCalledWith(
      PAID_FUNNEL_EVENTS.retentionOfferAccepted,
      expect.objectContaining({
        retention_offer: "pause",
        pause_months: 2,
        subscription_tier: "pro-plus",
      }),
    );
    expect(mockPostHogEvent).toHaveBeenCalledWith(
      PAID_FUNNEL_EVENTS.subscriptionPauseScheduled,
      expect.objectContaining({ pause_id: "pause_1" }),
    );
  });

  it("rejects unsupported durations before touching billing", async () => {
    const { default: pauseSubscriptionAction } =
      await import("../pause-subscription");

    await expect(
      pauseSubscriptionAction({ ...validInput, months: 6 }),
    ).rejects.toThrow(BILLING_ERRORS.invalidPauseDuration);
    expect(mockGetBillingActionContext).not.toHaveBeenCalled();
  });

  it("refuses when the offer is not eligible for the subscription", async () => {
    mockListSubscriptions.mockResolvedValue({
      data: [
        proPlusSubscription({
          items: {
            data: [
              {
                quantity: 1,
                current_period_end: PERIOD_END_SECONDS,
                price: {
                  id: "price_pro_plus_yearly",
                  lookup_key: "pro-plus-yearly-plan",
                  unit_amount: 60000,
                  currency: "usd",
                  recurring: { interval: "year", interval_count: 1 },
                },
              },
            ],
          },
        }),
      ],
    } as never);
    const { default: pauseSubscriptionAction } =
      await import("../pause-subscription");

    await expect(pauseSubscriptionAction(validInput)).rejects.toThrow(
      BILLING_ERRORS.retentionOfferUnavailable,
    );
    expect(mockUpdateSubscription).not.toHaveBeenCalled();
    expect(mockConvexMutation).not.toHaveBeenCalledWith(
      "subscriptionPauses.recordScheduledPause",
      expect.anything(),
    );
  });

  it("refuses when the rollout flag is off for the user", async () => {
    mockIsPauseOfferEnabledForUser.mockResolvedValue(false as never);
    const { default: pauseSubscriptionAction } =
      await import("../pause-subscription");

    await expect(pauseSubscriptionAction(validInput)).rejects.toThrow(
      BILLING_ERRORS.retentionOfferUnavailable,
    );
    expect(mockUpdateSubscription).not.toHaveBeenCalled();
  });

  it("returns the existing pause when one is already scheduled", async () => {
    mockListSubscriptions.mockResolvedValue({
      data: [
        proPlusSubscription({
          cancel_at_period_end: true,
          metadata: {
            hackeraiPauseId: "pause_existing",
            hackeraiPauseMonths: "1",
            hackeraiPauseResumeAt: "1795000000000",
          },
        }),
      ],
    } as never);
    const { default: pauseSubscriptionAction } =
      await import("../pause-subscription");

    await expect(pauseSubscriptionAction(validInput)).resolves.toEqual({
      paused: true,
      months: 1,
      pauseEffectiveAt: PERIOD_END_SECONDS * 1000,
      resumeAt: 1_795_000_000_000,
      alreadyScheduled: true,
    });
    expect(mockUpdateSubscription).not.toHaveBeenCalled();
  });

  it("rolls back the pause record when Stripe rejects the update", async () => {
    mockUpdateSubscription.mockRejectedValue(new Error("stripe down") as never);
    const { default: pauseSubscriptionAction } =
      await import("../pause-subscription");

    await expect(pauseSubscriptionAction(validInput)).rejects.toThrow(
      "stripe down",
    );
    expect(mockConvexMutation).toHaveBeenCalledWith(
      "subscriptionPauses.cancelScheduledPause",
      expect.objectContaining({ stripeSubscriptionId: "sub_123" }),
    );
    expect(mockPostHogEvent).not.toHaveBeenCalledWith(
      PAID_FUNNEL_EVENTS.retentionOfferAccepted,
      expect.anything(),
    );
  });
});
