import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";

const mockConstructEvent = jest.fn();
const mockRetrieveCustomer = jest.fn();
const mockRetrieveSubscription = jest.fn();
const mockUpdateSubscription = jest.fn();
const mockListMemberships = jest.fn();
const mockConvexMutation = jest.fn();
const mockResetRateLimitBuckets = jest.fn();
const mockStashOldBucketRemaining = jest.fn();
const mockPopOldBucketRemaining = jest.fn();
const mockInitProratedBucket = jest.fn();
const mockClearOrgRemovedUsage = jest.fn();
const mockPostHogEvent = jest.fn();
const mockPostHogWarn = jest.fn();
const mockPostHogError = jest.fn();
const mockPostHogFlush = jest.fn();

jest.mock("next/server", () => ({
  after: jest.fn((callback: () => void) => callback()),
  NextResponse: {
    json: jest.fn((body: unknown, init?: ResponseInit) => ({
      status: init?.status ?? 200,
      json: async () => body,
    })),
  },
}));

jest.mock("@/app/api/stripe", () => ({
  stripe: {
    webhooks: {
      constructEvent: mockConstructEvent,
    },
    customers: {
      retrieve: mockRetrieveCustomer,
    },
    subscriptions: {
      retrieve: mockRetrieveSubscription,
      update: mockUpdateSubscription,
    },
  },
}));

jest.mock("@/app/api/workos", () => ({
  workos: {
    userManagement: {
      listOrganizationMemberships: mockListMemberships,
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
    extraUsage: {
      checkAndMarkWebhook: "extraUsage.checkAndMarkWebhook",
    },
    referrals: {
      awardConversionReward: "referrals.awardConversionReward",
      setReferralCodesPaidEligibility:
        "referrals.setReferralCodesPaidEligibility",
      recordReferralCheckoutSession: "referrals.recordReferralCheckoutSession",
    },
    unitEconomics: {
      recordRevenueEvent: "unitEconomics.recordRevenueEvent",
      recordPaidStartMix: "unitEconomics.recordPaidStartMix",
      recordPaidStartEvent: "unitEconomics.recordPaidStartEvent",
    },
    cancellationReasons: {
      recordCancellation: "cancellationReasons.recordCancellation",
      completeCancellationReason:
        "cancellationReasons.completeCancellationReason",
      markCancellationCompleted:
        "cancellationReasons.markCancellationCompleted",
    },
  },
}));

jest.mock("@/lib/rate-limit", () => ({
  resetRateLimitBuckets: mockResetRateLimitBuckets,
  stashOldBucketRemaining: mockStashOldBucketRemaining,
  popOldBucketRemaining: mockPopOldBucketRemaining,
  initProratedBucket: mockInitProratedBucket,
  clearOrgRemovedUsage: mockClearOrgRemovedUsage,
}));

jest.mock("@/lib/posthog/server", () => ({
  phLogger: {
    event: mockPostHogEvent,
    warn: mockPostHogWarn,
    error: mockPostHogError,
    flush: mockPostHogFlush,
  },
}));

jest.mock("@/lib/referrals/config", () => ({
  getReferralRewardConfig: () => ({
    enabled: false,
    referrerRewardDollars: 0,
  }),
}));

function makeWebhookRequest() {
  return {
    text: jest.fn().mockResolvedValue("{}"),
    headers: {
      get: jest.fn((name: string) =>
        name === "stripe-signature" ? "sig_test" : null,
      ),
    },
  } as any;
}

describe("POST /api/subscription/webhook", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.STRIPE_SUBSCRIPTION_WEBHOOK_SECRET = "whsec_test";
    process.env.CONVEX_SERVICE_ROLE_KEY = "service_key";

    jest.spyOn(console, "info").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});

    mockConvexMutation.mockResolvedValue({ alreadyProcessed: false } as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.STRIPE_SUBSCRIPTION_WEBHOOK_SECRET;
    delete process.env.CONVEX_SERVICE_ROLE_KEY;
  });

  it("skips legacy PentestGPT invoices before resolving the old product as a HackerAI tier", async () => {
    mockConstructEvent.mockReturnValue({
      id: "evt_invoice_paid_legacy",
      type: "invoice.paid",
      data: {
        object: {
          id: "in_legacy",
          customer: "cus_legacy",
          amount_paid: 2000,
          currency: "usd",
          billing_reason: "subscription_cycle",
          parent: {
            subscription_details: {
              subscription: "sub_legacy",
            },
          },
          status_transitions: {
            paid_at: 1_719_504_000,
          },
        },
      },
    });
    mockRetrieveCustomer.mockResolvedValue({
      deleted: false,
      id: "cus_legacy",
      metadata: {
        userId: "b8c832c4-3e1e-4a76-89c1-28a5b4f56302",
      },
    } as never);

    const { POST } = await import("../route");

    const response = await POST(makeWebhookRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ received: true });
    expect(mockRetrieveCustomer).toHaveBeenCalledWith("cus_legacy");
    expect(mockRetrieveSubscription).not.toHaveBeenCalled();
    expect(mockListMemberships).not.toHaveBeenCalled();
    expect(mockResetRateLimitBuckets).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledWith(
      "[Subscription Webhook] invoice.paid: skipping legacy customer invoice in_legacy for customer cus_legacy",
    );
    expect(mockConvexMutation).toHaveBeenNthCalledWith(
      1,
      "extraUsage.checkAndMarkWebhook",
      {
        serviceKey: "service_key",
        eventId: "evt_invoice_paid_legacy",
        checkOnly: true,
      },
    );
    expect(mockConvexMutation).toHaveBeenNthCalledWith(
      2,
      "extraUsage.checkAndMarkWebhook",
      {
        serviceKey: "service_key",
        eventId: "evt_invoice_paid_legacy",
      },
    );
  });

  it("skips old PentestGPT subscription products even after the customer has WorkOS metadata", async () => {
    mockConstructEvent.mockReturnValue({
      id: "evt_invoice_paid_migrated_legacy",
      type: "invoice.paid",
      data: {
        object: {
          id: "in_migrated_legacy",
          customer: "cus_migrated",
          amount_paid: 2000,
          currency: "usd",
          billing_reason: "subscription_cycle",
          parent: {
            subscription_details: {
              subscription: "sub_legacy",
            },
          },
          status_transitions: {
            paid_at: 1_719_504_000,
          },
        },
      },
    });
    mockRetrieveCustomer.mockResolvedValue({
      deleted: false,
      id: "cus_migrated",
      metadata: {
        workOSOrganizationId: "org_migrated",
      },
    } as never);
    mockListMemberships.mockResolvedValue({
      autoPagination: jest.fn().mockResolvedValue([{ userId: "user_current" }]),
    } as never);
    mockRetrieveSubscription.mockResolvedValue({
      id: "sub_legacy",
      metadata: {},
      items: {
        data: [
          {
            quantity: 1,
            price: {
              id: "price_legacy",
              lookup_key: "pro-monthly-plan",
              recurring: { interval: "month", interval_count: 1 },
              product: {
                id: "prod_legacy",
                name: "PentestGPT Pro Subscription",
                metadata: {},
              },
            },
          },
        ],
      },
    } as never);

    const { POST } = await import("../route");

    const response = await POST(makeWebhookRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ received: true });
    expect(mockRetrieveSubscription).toHaveBeenCalledWith("sub_legacy", {
      expand: ["items.data.price", "items.data.price.product"],
    });
    expect(mockResetRateLimitBuckets).not.toHaveBeenCalled();
    expect(mockPostHogEvent).not.toHaveBeenCalledWith(
      "subscription_started",
      expect.anything(),
    );
    expect(console.info).toHaveBeenCalledWith(
      "[Subscription Webhook] invoice.paid: skipping legacy PentestGPT subscription sub_legacy for invoice in_migrated_legacy",
    );
  });

  it("skips deleted subscriptions that do not have a HackerAI price lookup key", async () => {
    mockConstructEvent.mockReturnValue({
      id: "evt_subscription_deleted_legacy",
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_legacy_deleted",
          customer: "cus_migrated",
          items: {
            data: [
              {
                price: {
                  id: "price_legacy",
                  lookup_key: null,
                },
              },
            ],
          },
          metadata: {},
          cancellation_details: {
            reason: "cancellation_requested",
          },
        },
      },
    });

    const { POST } = await import("../route");

    const response = await POST(makeWebhookRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ received: true });
    expect(mockRetrieveCustomer).not.toHaveBeenCalled();
    expect(mockListMemberships).not.toHaveBeenCalled();
    expect(mockPostHogEvent).not.toHaveBeenCalledWith(
      "subscription_cancelled",
      expect.anything(),
    );
    expect(console.info).toHaveBeenCalledWith(
      "[Subscription Webhook] subscription.deleted: skipping subscription sub_legacy_deleted without HackerAI price lookup_key for customer cus_migrated",
    );
  });
});
