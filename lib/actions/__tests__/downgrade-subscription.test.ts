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
const mockCreatePreview = jest.fn();
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
    invoices: { createPreview: mockCreatePreview },
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
  getDowngradeOfferFlagState: mockDowngradeFlag,
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
    mockDowngradeFlag.mockResolvedValue("enabled" as never);
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
    mockCreatePreview.mockResolvedValue({
      lines: { data: [{ amount: -3150 }, { amount: 1312 }] },
    } as never);
    mockUpdateSubscription.mockResolvedValue({
      ...proPlusSubscription(),
      status: "active",
    } as never);
  });

  afterEach(() => {
    if (originalServiceKey === undefined) {
      delete process.env.CONVEX_SERVICE_ROLE_KEY;
    } else {
      process.env.CONVEX_SERVICE_ROLE_KEY = originalServiceKey;
    }
  });

  it("switches Pro+ to Pro immediately with proration and records the retention", async () => {
    const { default: downgradeSubscriptionAction } =
      await import("../downgrade-subscription");

    await expect(downgradeSubscriptionAction(validInput)).resolves.toEqual({
      downgraded: true,
      fromTier: "pro-plus",
      toTier: "pro",
      toPlan: "pro-monthly-plan",
      targetAmountDollars: 25,
      proratedCreditDollars: 31.5,
      currency: "usd",
    });

    expect(mockListPrices).toHaveBeenCalledWith({
      lookup_keys: ["pro-monthly-plan"],
      active: true,
      limit: 1,
    });
    expect(mockUpdateSubscription).toHaveBeenCalledWith(
      "sub_pp",
      expect.objectContaining({
        items: [{ id: "si_pp", price: "price_pro", quantity: 1 }],
        proration_behavior: "always_invoice",
        payment_behavior: "pending_if_incomplete",
        metadata: expect.objectContaining({
          checkoutAttemptId: "ca_1",
          checkoutType: "subscription_change",
          checkoutSource: "retention_downgrade",
          hackeraiRetentionDowngradeFromPlan: "pro-plus-monthly-plan",
        }),
      }),
    );
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
      }),
    );
    expect(mockPostHogEvent).toHaveBeenCalledWith(
      PAID_FUNNEL_EVENTS.retentionDowngradeApplied,
      expect.objectContaining({
        $set: expect.objectContaining({ subscription_tier: "pro" }),
      }),
    );
  });

  it("still offers the switch when the proration preview fails", async () => {
    mockCreatePreview.mockRejectedValue(new Error("preview down") as never);
    const { default: downgradeSubscriptionAction } =
      await import("../downgrade-subscription");

    const result = await downgradeSubscriptionAction(validInput);

    expect(result).toMatchObject({ downgraded: true, toTier: "pro" });
    expect(result).not.toHaveProperty("proratedCreditDollars");
    expect(mockUpdateSubscription).toHaveBeenCalledTimes(1);
  });

  it("refuses Pro, non-price reasons, repeat offers, and a disabled flag", async () => {
    const { default: downgradeSubscriptionAction } =
      await import("../downgrade-subscription");

    mockListSubscriptions.mockResolvedValueOnce({
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
    await expect(downgradeSubscriptionAction(validInput)).rejects.toThrow(
      BILLING_ERRORS.retentionOfferUnavailable,
    );

    await expect(
      downgradeSubscriptionAction({
        cancellationReason: {
          reasonCategory: "hit_usage_limits",
          reasonSubcategory: "insufficient_included_usage",
          reasonDetails: "Ran out of usage",
        },
      }),
    ).rejects.toThrow(BILLING_ERRORS.retentionOfferUnavailable);

    mockListSubscriptions.mockResolvedValueOnce({
      data: [
        proPlusSubscription({
          metadata: {
            hackeraiRetentionDowngradeFromPlan: "ultra-monthly-plan",
          },
        }),
      ],
    } as never);
    await expect(downgradeSubscriptionAction(validInput)).rejects.toThrow(
      BILLING_ERRORS.retentionOfferUnavailable,
    );

    mockDowngradeFlag.mockResolvedValueOnce("disabled" as never);
    await expect(downgradeSubscriptionAction(validInput)).rejects.toThrow(
      BILLING_ERRORS.retentionOfferUnavailable,
    );

    expect(mockUpdateSubscription).not.toHaveBeenCalled();
  });
});
