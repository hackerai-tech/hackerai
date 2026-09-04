import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { PAID_FUNNEL_EVENTS } from "@/lib/analytics/paid-funnel";
import { PAUSE_RESUME_RETRY_DELAY_MS } from "@/lib/billing/retention-offers";

const mockListSubscriptions = jest.fn();
const mockCreateSubscription = jest.fn();
const mockRetrievePaymentMethod = jest.fn();
const mockListPaymentMethods = jest.fn();
const mockRetrieveCustomer = jest.fn();
const mockConvexMutation = jest.fn();
const mockPostHogEvent = jest.fn();
const mockPostHogError = jest.fn();

jest.mock("@/app/api/stripe", () => ({
  stripe: {
    subscriptions: {
      list: mockListSubscriptions,
      create: mockCreateSubscription,
    },
    paymentMethods: {
      retrieve: mockRetrievePaymentMethod,
      list: mockListPaymentMethods,
    },
    customers: {
      retrieve: mockRetrieveCustomer,
    },
  },
}));

jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({
    mutation: mockConvexMutation,
  }),
}));

jest.mock("@/convex/_generated/api", () => ({
  api: {
    subscriptionPauses: {
      claimResume: "subscriptionPauses.claimResume",
      markPauseSuperseded: "subscriptionPauses.markPauseSuperseded",
      markResumeFailed: "subscriptionPauses.markResumeFailed",
      markResumeSucceeded: "subscriptionPauses.markResumeSucceeded",
    },
  },
}));

jest.mock("@/lib/posthog/server", () => ({
  phLogger: {
    event: mockPostHogEvent,
    info: jest.fn(),
    warn: jest.fn(),
    error: mockPostHogError,
  },
}));

const NOW = 1_795_000_000_000;

function pauseRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "pause_1",
    userId: "user_123",
    organizationId: "org_123",
    stripeCustomerId: "cus_123",
    stripeSubscriptionId: "sub_old",
    stripePriceId: "price_pro_plus",
    stripePriceLookupKey: "pro-plus-monthly-plan",
    subscriptionTier: "pro-plus",
    quantity: 1,
    stripePaymentMethodId: "pm_123",
    reasonCategory: "not_using_enough",
    pauseMonths: 2,
    requestedAt: NOW - 90 * 86_400_000,
    pauseEffectiveAt: NOW - 60 * 86_400_000,
    resumeAt: NOW,
    status: "paused",
    resumeAttemptCount: 0,
    ...overrides,
  };
}

describe("resumePausedSubscription", () => {
  const originalServiceKey = process.env.CONVEX_SERVICE_ROLE_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CONVEX_SERVICE_ROLE_KEY = "service-key";
    mockConvexMutation.mockImplementation((async (
      name: string,
      args: Record<string, unknown>,
    ) => {
      if (name === "subscriptionPauses.claimResume") {
        return pauseRecord({
          status: "resuming",
          resumeAttemptCount: 1,
          id: args.pauseId,
        });
      }
      return null;
    }) as never);
    mockListSubscriptions.mockResolvedValue({ data: [] } as never);
    mockRetrievePaymentMethod.mockResolvedValue({
      id: "pm_123",
      customer: "cus_123",
    } as never);
    mockCreateSubscription.mockResolvedValue({
      id: "sub_new",
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

  it("re-creates the subscription with the saved card and marks the pause resumed", async () => {
    const { resumePausedSubscription } = await import("../pause-resume");

    const result = await resumePausedSubscription(pauseRecord() as never, {
      trigger: "cron",
      now: NOW,
    });

    expect(result).toEqual({
      outcome: "resumed",
      stripeSubscriptionId: "sub_new",
    });
    expect(mockConvexMutation).toHaveBeenCalledWith(
      "subscriptionPauses.claimResume",
      expect.objectContaining({ pauseId: "pause_1", manual: false, now: NOW }),
    );
    expect(mockCreateSubscription).toHaveBeenCalledWith({
      customer: "cus_123",
      items: [{ price: "price_pro_plus", quantity: 1 }],
      default_payment_method: "pm_123",
      payment_behavior: "error_if_incomplete",
      metadata: expect.objectContaining({
        checkoutType: "pause_resume",
        checkoutSource: "pause_resume",
        hackeraiPauseId: "pause_1",
        hackeraiResumedFromSubscriptionId: "sub_old",
      }),
    });
    expect(mockConvexMutation).toHaveBeenCalledWith(
      "subscriptionPauses.markResumeSucceeded",
      expect.objectContaining({
        pauseId: "pause_1",
        resumedStripeSubscriptionId: "sub_new",
      }),
    );
    expect(mockPostHogEvent).toHaveBeenCalledWith(
      PAID_FUNNEL_EVENTS.subscriptionPauseResumed,
      expect.objectContaining({
        userId: "user_123",
        resume_trigger: "cron",
        stripe_subscription_id: "sub_new",
      }),
    );
  });

  it("does nothing when the pause cannot be claimed", async () => {
    mockConvexMutation.mockResolvedValue(null as never);
    const { resumePausedSubscription } = await import("../pause-resume");

    await expect(
      resumePausedSubscription(pauseRecord() as never, {
        trigger: "cron",
        now: NOW,
      }),
    ).resolves.toEqual({ outcome: "not_claimable" });
    expect(mockCreateSubscription).not.toHaveBeenCalled();
  });

  it("marks the pause superseded when the customer already has a live subscription", async () => {
    mockListSubscriptions.mockResolvedValue({
      data: [{ id: "sub_manual", status: "active" }],
    } as never);
    const { resumePausedSubscription } = await import("../pause-resume");

    await expect(
      resumePausedSubscription(pauseRecord() as never, {
        trigger: "manual",
        now: NOW,
      }),
    ).resolves.toEqual({
      outcome: "superseded",
      stripeSubscriptionId: "sub_manual",
    });
    expect(mockConvexMutation).toHaveBeenCalledWith(
      "subscriptionPauses.markPauseSuperseded",
      expect.objectContaining({
        pauseId: "pause_1",
        stripeSubscriptionId: "sub_manual",
      }),
    );
    expect(mockCreateSubscription).not.toHaveBeenCalled();
  });

  it("falls back to the customer's default card when the saved one is gone", async () => {
    mockRetrievePaymentMethod.mockRejectedValue({
      type: "StripeInvalidRequestError",
      code: "resource_missing",
    } as never);
    mockRetrieveCustomer.mockResolvedValue({
      id: "cus_123",
      invoice_settings: { default_payment_method: "pm_default" },
    } as never);
    const { resumePausedSubscription } = await import("../pause-resume");

    await resumePausedSubscription(pauseRecord() as never, {
      trigger: "cron",
      now: NOW,
    });

    expect(mockCreateSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ default_payment_method: "pm_default" }),
    );
  });

  it("fails permanently without a payment method", async () => {
    mockRetrievePaymentMethod.mockResolvedValue({
      id: "pm_123",
      customer: "cus_other",
    } as never);
    mockRetrieveCustomer.mockResolvedValue({
      id: "cus_123",
      invoice_settings: { default_payment_method: null },
    } as never);
    mockListPaymentMethods.mockResolvedValue({ data: [] } as never);
    const { resumePausedSubscription } = await import("../pause-resume");

    const result = await resumePausedSubscription(pauseRecord() as never, {
      trigger: "cron",
      now: NOW,
    });

    expect(result).toMatchObject({
      outcome: "failed",
      failureKind: "no_payment_method",
      retryScheduled: false,
    });
    expect(mockConvexMutation).toHaveBeenCalledWith(
      "subscriptionPauses.markResumeFailed",
      expect.objectContaining({
        pauseId: "pause_1",
        error: "no_payment_method",
      }),
    );
    expect(mockConvexMutation).not.toHaveBeenCalledWith(
      "subscriptionPauses.markResumeFailed",
      expect.objectContaining({ retryAt: expect.any(Number) }),
    );
  });

  it("schedules a retry after a card decline on the automatic path", async () => {
    mockCreateSubscription.mockRejectedValue({
      type: "StripeCardError",
      message: "Your card was declined.",
    } as never);
    const { resumePausedSubscription } = await import("../pause-resume");

    const result = await resumePausedSubscription(pauseRecord() as never, {
      trigger: "cron",
      now: NOW,
    });

    expect(result).toMatchObject({
      outcome: "failed",
      failureKind: "payment_failed",
      retryScheduled: true,
    });
    expect(mockConvexMutation).toHaveBeenCalledWith(
      "subscriptionPauses.markResumeFailed",
      expect.objectContaining({
        pauseId: "pause_1",
        retryAt: NOW + PAUSE_RESUME_RETRY_DELAY_MS,
      }),
    );
    expect(mockPostHogEvent).toHaveBeenCalledWith(
      PAID_FUNNEL_EVENTS.subscriptionPauseResumeFailed,
      expect.objectContaining({
        failure_kind: "payment_failed",
        retry_scheduled: true,
      }),
    );
    expect(mockPostHogError).not.toHaveBeenCalled();
  });

  it("does not schedule automatic retries for a manual resume", async () => {
    mockCreateSubscription.mockRejectedValue({
      type: "StripeCardError",
      message: "Your card was declined.",
    } as never);
    const { resumePausedSubscription } = await import("../pause-resume");

    const result = await resumePausedSubscription(pauseRecord() as never, {
      trigger: "manual",
      now: NOW,
    });

    expect(result).toMatchObject({
      outcome: "failed",
      failureKind: "payment_failed",
      retryScheduled: false,
    });
    expect(mockConvexMutation).toHaveBeenCalledWith(
      "subscriptionPauses.markResumeFailed",
      expect.not.objectContaining({ retryAt: expect.anything() }),
    );
  });
});
