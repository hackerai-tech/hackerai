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
import { RETENTION_DISCOUNT } from "@/lib/billing/retention-offers";

const mockListSubscriptions = jest.fn();
const mockUpdateSubscription = jest.fn();
const mockRetrieveCoupon = jest.fn();
const mockCreateCoupon = jest.fn();
const mockGetBillingActionContext = jest.fn();
const mockConvexMutation = jest.fn();
const mockConvexQuery = jest.fn();
const mockIsRetentionOffersEnabledForUser = jest.fn();
const mockPostHogEvent = jest.fn();

jest.mock("@/app/api/stripe", () => ({
  stripe: {
    subscriptions: {
      list: mockListSubscriptions,
      update: mockUpdateSubscription,
    },
    coupons: {
      retrieve: mockRetrieveCoupon,
      create: mockCreateCoupon,
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
  isRetentionOffersEnabledForUser: mockIsRetentionOffersEnabledForUser,
}));

jest.mock("@/lib/posthog/server", () => ({
  phLogger: {
    event: mockPostHogEvent,
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  },
}));

const PERIOD_END_SECONDS = 1_790_000_000;

function ultraSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub_ultra",
    status: "active",
    cancel_at_period_end: false,
    metadata: {},
    discounts: [],
    items: {
      data: [
        {
          quantity: 1,
          current_period_end: PERIOD_END_SECONDS,
          price: {
            id: "price_ultra",
            lookup_key: "ultra-monthly-plan",
            unit_amount: 20000,
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
    reasonDetails: "Great tool, too pricey this quarter",
  },
};

describe("acceptRetentionDiscountAction", () => {
  const originalServiceKey = process.env.CONVEX_SERVICE_ROLE_KEY;
  const originalCouponId = process.env.STRIPE_RETENTION_COUPON_ID;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CONVEX_SERVICE_ROLE_KEY = "service-key";
    delete process.env.STRIPE_RETENTION_COUPON_ID;
    mockGetBillingActionContext.mockResolvedValue({
      organizationId: "org_123",
      user: { id: "user_123" },
      stripeCustomerId: "cus_123",
    } as never);
    mockIsRetentionOffersEnabledForUser.mockResolvedValue(true as never);
    mockConvexQuery.mockResolvedValue(null as never);
    mockConvexMutation.mockImplementation((async (name: string) =>
      name === "cancellationReasons.recordCancellationStarted"
        ? "reason_1"
        : null) as never);
    mockListSubscriptions.mockResolvedValue({
      data: [ultraSubscription()],
    } as never);
    mockRetrieveCoupon.mockResolvedValue({
      id: RETENTION_DISCOUNT.couponId,
      valid: true,
    } as never);
    mockUpdateSubscription.mockResolvedValue(ultraSubscription() as never);
  });

  afterEach(() => {
    if (originalServiceKey === undefined) {
      delete process.env.CONVEX_SERVICE_ROLE_KEY;
    } else {
      process.env.CONVEX_SERVICE_ROLE_KEY = originalServiceKey;
    }
    if (originalCouponId === undefined) {
      delete process.env.STRIPE_RETENTION_COUPON_ID;
    } else {
      process.env.STRIPE_RETENTION_COUPON_ID = originalCouponId;
    }
  });

  it("applies the repeating coupon and marks the cancellation as retained", async () => {
    const { default: acceptRetentionDiscountAction } =
      await import("../accept-retention-discount");

    await expect(acceptRetentionDiscountAction(validInput)).resolves.toEqual({
      applied: true,
      percentOff: 50,
      durationMonths: 2,
      currentAmountDollars: 200,
      discountedAmountDollars: 100,
      currency: "usd",
      nextRenewalAt: PERIOD_END_SECONDS * 1000,
    });

    expect(mockUpdateSubscription).toHaveBeenCalledWith("sub_ultra", {
      discounts: [{ coupon: RETENTION_DISCOUNT.couponId }],
      metadata: expect.objectContaining({
        hackeraiRetentionDiscountCouponId: RETENTION_DISCOUNT.couponId,
        hackeraiRetentionDiscountPercentOff: "50",
        hackeraiRetentionDiscountDurationMonths: "2",
      }),
    });
    expect(mockConvexMutation).toHaveBeenCalledWith(
      "cancellationReasons.recordRetentionOfferAccepted",
      expect.objectContaining({
        cancellationReasonId: "reason_1",
        retentionOffer: "discount",
      }),
    );
    expect(mockPostHogEvent).toHaveBeenCalledWith(
      PAID_FUNNEL_EVENTS.retentionOfferAccepted,
      expect.objectContaining({
        retention_offer: "discount",
        discount_percent_off: 50,
        subscription_tier: "ultra",
      }),
    );
  });

  it("creates the coupon once when it does not exist yet", async () => {
    mockRetrieveCoupon.mockRejectedValue({
      type: "StripeInvalidRequestError",
      code: "resource_missing",
    } as never);
    mockCreateCoupon.mockResolvedValue({
      id: RETENTION_DISCOUNT.couponId,
    } as never);
    const { default: acceptRetentionDiscountAction } =
      await import("../accept-retention-discount");

    await acceptRetentionDiscountAction(validInput);

    expect(mockCreateCoupon).toHaveBeenCalledWith(
      expect.objectContaining({
        id: RETENTION_DISCOUNT.couponId,
        percent_off: 50,
        duration: "repeating",
        duration_in_months: 2,
      }),
    );
  });

  it("uses a configured coupon id without touching the coupon API", async () => {
    process.env.STRIPE_RETENTION_COUPON_ID = "coupon_custom";
    const { default: acceptRetentionDiscountAction } =
      await import("../accept-retention-discount");

    await acceptRetentionDiscountAction(validInput);

    expect(mockRetrieveCoupon).not.toHaveBeenCalled();
    expect(mockUpdateSubscription).toHaveBeenCalledWith(
      "sub_ultra",
      expect.objectContaining({ discounts: [{ coupon: "coupon_custom" }] }),
    );
  });

  it("refuses a second discount on the same subscription", async () => {
    mockListSubscriptions.mockResolvedValue({
      data: [
        ultraSubscription({
          metadata: {
            hackeraiRetentionDiscountCouponId: RETENTION_DISCOUNT.couponId,
            hackeraiRetentionDiscountPercentOff: "50",
            hackeraiRetentionDiscountDurationMonths: "2",
          },
        }),
      ],
    } as never);
    const { default: acceptRetentionDiscountAction } =
      await import("../accept-retention-discount");

    await expect(acceptRetentionDiscountAction(validInput)).rejects.toThrow(
      BILLING_ERRORS.retentionOfferUnavailable,
    );
    expect(mockUpdateSubscription).not.toHaveBeenCalled();
  });

  it("does not discount Pro subscriptions", async () => {
    mockListSubscriptions.mockResolvedValue({
      data: [
        ultraSubscription({
          items: {
            data: [
              {
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
    const { default: acceptRetentionDiscountAction } =
      await import("../accept-retention-discount");

    await expect(acceptRetentionDiscountAction(validInput)).rejects.toThrow(
      BILLING_ERRORS.retentionOfferUnavailable,
    );
  });
});
