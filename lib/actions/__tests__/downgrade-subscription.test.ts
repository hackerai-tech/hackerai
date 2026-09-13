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
const mockListPrices = jest.fn();
const mockCreateSchedule = jest.fn();
const mockUpdateSchedule = jest.fn();
const mockReleaseSchedule = jest.fn();
const mockGetBillingActionContext = jest.fn();
const mockConvexMutation = jest.fn();
const mockConvexQuery = jest.fn();
const mockPauseFlag = jest.fn();
const mockDowngradeFlag = jest.fn();
const mockPostHogEvent = jest.fn();
const mockPostHogWarn = jest.fn();

jest.mock("@/app/api/stripe", () => ({
  stripe: {
    subscriptions: {
      list: mockListSubscriptions,
      update: mockUpdateSubscription,
    },
    prices: { list: mockListPrices },
    subscriptionSchedules: {
      create: mockCreateSchedule,
      update: mockUpdateSchedule,
      release: mockReleaseSchedule,
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
    },
  },
}));

jest.mock("@/lib/billing/retention-offers.server", () => ({
  getPauseOfferFlagState: mockPauseFlag,
  getDowngradeOfferFlag: mockDowngradeFlag,
  isPauseOfferEnabledForUser: async () => false,
}));

jest.mock("@/lib/posthog/server", () => ({
  phLogger: {
    event: mockPostHogEvent,
    warn: mockPostHogWarn,
    error: jest.fn(),
    info: jest.fn(),
  },
}));

const PERIOD_END_SECONDS = 1_790_000_000;

function proPlusSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub_pp",
    status: "active",
    cancel_at_period_end: false,
    metadata: { checkoutAttemptId: "ca_1" },
    items: {
      data: [
        {
          id: "si_pp",
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
  cancellationReason: {
    reasonCategory: "too_expensive",
    reasonSubcategory: "too_expensive_low_frequency",
    reasonDetails: "Great, but more than I need",
  },
};

describe("downgradeSubscriptionAction", () => {
  const originalServiceKey = process.env.CONVEX_SERVICE_ROLE_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CONVEX_SERVICE_ROLE_KEY = "service-key";
    mockGetBillingActionContext.mockResolvedValue({
      organizationId: "org_123",
      user: { id: "user_123" },
      stripeCustomerId: "cus_123",
    } as never);
    mockPauseFlag.mockResolvedValue("disabled" as never);
    mockDowngradeFlag.mockResolvedValue({
      state: "enabled",
      reasonPolicy: "price_reasons",
    } as never);
    mockConvexQuery.mockResolvedValue(null as never);
    mockConvexMutation.mockImplementation((async (name: string) =>
      name === "cancellationReasons.recordCancellationStarted"
        ? "reason_1"
        : null) as never);
    mockListSubscriptions.mockResolvedValue({
      data: [proPlusSubscription()],
    } as never);
    mockListPrices.mockResolvedValue({
      data: [
        {
          id: "price_pro",
          lookup_key: "pro-monthly-plan",
          unit_amount: 2500,
          currency: "usd",
        },
      ],
    } as never);
    mockCreateSchedule.mockResolvedValue({
      id: "sub_sched_1",
      phases: [
        {
          start_date: PERIOD_END_SECONDS - 30 * 86_400,
          end_date: PERIOD_END_SECONDS,
          items: [{ price: "price_pro_plus", quantity: 1 }],
          discounts: [],
        },
      ],
    } as never);
    mockUpdateSchedule.mockResolvedValue({
      id: "sub_sched_1",
      phases: [
        {
          start_date: PERIOD_END_SECONDS - 30 * 86_400,
          end_date: PERIOD_END_SECONDS,
        },
        {
          start_date: PERIOD_END_SECONDS,
          end_date: PERIOD_END_SECONDS + 30 * 86_400,
        },
      ],
    } as never);
  });

  afterEach(() => {
    if (originalServiceKey === undefined) {
      delete process.env.CONVEX_SERVICE_ROLE_KEY;
    } else {
      process.env.CONVEX_SERVICE_ROLE_KEY = originalServiceKey;
    }
  });

  it("schedules Pro+ to Pro at the paid-through date and records the retention", async () => {
    const { default: downgradeSubscriptionAction } =
      await import("../downgrade-subscription");

    await expect(downgradeSubscriptionAction(validInput)).resolves.toEqual({
      scheduled: true,
      effectiveAt: PERIOD_END_SECONDS * 1000,
      fromTier: "pro-plus",
      toTier: "pro",
      toPlan: "pro-monthly-plan",
      targetAmountDollars: 25,
      currency: "usd",
    });

    expect(mockListPrices).toHaveBeenCalledWith({
      lookup_keys: ["pro-monthly-plan"],
      active: true,
      limit: 1,
    });
    expect(mockCreateSchedule).toHaveBeenCalledWith(
      { from_subscription: "sub_pp" },
      {
        idempotencyKey: expect.stringMatching(
          /^retention-downgrade:sub_pp:\d+$/,
        ),
      },
    );
    expect(mockUpdateSchedule).toHaveBeenCalledWith("sub_sched_1", {
      end_behavior: "release",
      metadata: expect.objectContaining({
        purpose: "retention_downgrade",
        fromPlan: "pro-plus-monthly-plan",
        toPlan: "pro-monthly-plan",
      }),
      phases: [
        {
          items: [{ price: "price_pro_plus", quantity: 1 }],
          start_date: PERIOD_END_SECONDS - 30 * 86_400,
          end_date: PERIOD_END_SECONDS,
          proration_behavior: "none",
        },
        {
          items: [{ price: "price_pro", quantity: 1 }],
          end_date: expect.any(Number),
          proration_behavior: "none",
          metadata: expect.objectContaining({
            checkoutAttemptId: "ca_1",
            checkoutType: "subscription_change",
            checkoutSource: "retention_downgrade",
            hackeraiRetentionDowngradeFromPlan: "pro-plus-monthly-plan",
          }),
        },
      ],
    });
    expect(mockUpdateSubscription).not.toHaveBeenCalled();
    expect(mockConvexMutation).toHaveBeenCalledWith(
      "cancellationReasons.recordRetentionOfferAccepted",
      expect.objectContaining({
        cancellationReasonId: "reason_1",
        retentionOffer: "downgrade",
      }),
    );
    expect(mockPostHogEvent).toHaveBeenCalledWith(
      PAID_FUNNEL_EVENTS.retentionOfferAccepted,
      expect.objectContaining({
        retention_offer: "downgrade",
        from_tier: "pro-plus",
        to_tier: "pro",
        stripe_subscription_schedule_id: "sub_sched_1",
      }),
    );
    expect(mockPostHogEvent).toHaveBeenCalledWith(
      PAID_FUNNEL_EVENTS.retentionDowngradeScheduled,
      expect.objectContaining({
        effective_at: new Date(PERIOD_END_SECONDS * 1000).toISOString(),
      }),
    );
  });

  it("releases the bare schedule when configuring the phases fails", async () => {
    mockUpdateSchedule.mockRejectedValue(
      new Error("stripe update failed") as never,
    );
    mockReleaseSchedule.mockResolvedValue({ id: "sub_sched_1" } as never);
    const { default: downgradeSubscriptionAction } =
      await import("../downgrade-subscription");

    await expect(downgradeSubscriptionAction(validInput)).rejects.toThrow(
      "stripe update failed",
    );
    expect(mockReleaseSchedule).toHaveBeenCalledWith("sub_sched_1");
    expect(mockConvexMutation).not.toHaveBeenCalledWith(
      "cancellationReasons.recordRetentionOfferAccepted",
      expect.anything(),
    );
    expect(mockPostHogEvent).not.toHaveBeenCalled();
  });

  it("replaces an already attached schedule instead of stacking one", async () => {
    mockReleaseSchedule.mockResolvedValue({ id: "sub_sched_old" } as never);
    mockListSubscriptions.mockResolvedValue({
      data: [proPlusSubscription({ schedule: "sub_sched_old" })],
    } as never);
    const { default: downgradeSubscriptionAction } =
      await import("../downgrade-subscription");

    await expect(downgradeSubscriptionAction(validInput)).rejects.toThrow(
      BILLING_ERRORS.retentionOfferUnavailable,
    );
    expect(mockCreateSchedule).not.toHaveBeenCalled();
    expect(mockPostHogWarn).toHaveBeenCalledWith(
      "retention_downgrade_rejected",
      expect.objectContaining({ reason: "downgrade_already_scheduled" }),
    );
  });

  it("keeps the pause available when the target price lookup fails", async () => {
    mockListPrices.mockRejectedValue(new Error("stripe down") as never);
    const { evaluateRetentionOffersForUser } =
      await import("@/lib/billing/retention-offer-evaluation");

    const evaluation = await evaluateRetentionOffersForUser({
      userId: "user_123",
      stripeCustomerId: "cus_123",
      reasonCategory: "too_expensive",
    });

    expect(evaluation.downgrade).toEqual({
      eligible: false,
      reason: "no_downgrade_target",
    });
    expect(mockPostHogWarn).toHaveBeenCalledWith(
      "retention_downgrade_target_price_lookup_failed",
      expect.objectContaining({ lookup_key: "pro-monthly-plan" }),
    );
  });

  it("refuses non-price reasons and a disabled flag", async () => {
    const { default: downgradeSubscriptionAction } =
      await import("../downgrade-subscription");

    await expect(
      downgradeSubscriptionAction({
        cancellationReason: {
          reasonCategory: "hit_usage_limits",
          reasonSubcategory: "insufficient_included_usage",
          reasonDetails: "Ran out of usage",
        },
      }),
    ).rejects.toThrow(BILLING_ERRORS.retentionOfferUnavailable);

    mockDowngradeFlag.mockResolvedValue({
      state: "disabled",
      reasonPolicy: "price_reasons",
    } as never);
    await expect(downgradeSubscriptionAction(validInput)).rejects.toThrow(
      BILLING_ERRORS.retentionOfferUnavailable,
    );

    expect(mockCreateSchedule).not.toHaveBeenCalled();
  });

  it("refuses Pro, which has no cheaper paid tier", async () => {
    mockListSubscriptions.mockResolvedValue({
      data: [
        proPlusSubscription({
          items: {
            data: [
              {
                id: "si_pro",
                quantity: 1,
                current_period_end: PERIOD_END_SECONDS,
                price: {
                  id: "price_pro",
                  lookup_key: "pro-monthly-plan",
                  unit_amount: 2500,
                  currency: "usd",
                  recurring: { interval: "month", interval_count: 1 },
                },
              },
            ],
          },
        }),
      ],
    } as never);
    const { default: downgradeSubscriptionAction } =
      await import("../downgrade-subscription");

    await expect(downgradeSubscriptionAction(validInput)).rejects.toThrow(
      BILLING_ERRORS.retentionOfferUnavailable,
    );
    expect(mockPostHogWarn).toHaveBeenCalledWith(
      "retention_downgrade_rejected",
      expect.objectContaining({ reason: "no_downgrade_target" }),
    );
    expect(mockCreateSchedule).not.toHaveBeenCalled();
  });
});
