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
const mockGetReferralRewardConfig = jest.fn();

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
  getReferralRewardConfig: mockGetReferralRewardConfig,
}));

function makeWebhookRequest({
  body = "{}",
  signature = "sig_test",
}: { body?: string; signature?: string | null } = {}) {
  return {
    text: jest.fn().mockResolvedValue(body),
    headers: {
      get: jest.fn((name: string) =>
        name === "stripe-signature" ? signature : null,
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
    mockGetReferralRewardConfig.mockReturnValue({
      enabled: false,
      referrerRewardDollars: 0,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.STRIPE_SUBSCRIPTION_WEBHOOK_SECRET;
    delete process.env.CONVEX_SERVICE_ROLE_KEY;
  });

  it("rejects invalid signatures with a sanitized warning before side effects", async () => {
    const rawBody =
      '{"id":"evt_test_reset_001","metadata":{"label":"über","userId":"user_secret"}}';
    const expectedPayloadBytes = new TextEncoder().encode(rawBody).byteLength;
    const rawSignature =
      "t=1782534490,v1=24cdc6311e7ea9669746b0e1cd1e8ac53b51ad96070e7919be7172b1dc1e9f30";
    const signatureError = Object.assign(
      new Error("No signatures found matching the expected signature"),
      {
        type: "StripeSignatureVerificationError",
        header: rawSignature,
        payload: rawBody,
      },
    );
    mockConstructEvent.mockImplementation(() => {
      throw signatureError;
    });

    const { POST } = await import("../route");

    const response = await POST(
      makeWebhookRequest({ body: rawBody, signature: rawSignature }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: "Webhook signature verification failed" });
    expect(mockConvexMutation).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      "[Subscription Webhook] Signature verification failed",
      expect.objectContaining({
        event: "stripe_webhook_signature_verification_failed",
        webhook: "subscription",
        route: "/api/subscription/webhook",
        payload_bytes: expectedPayloadBytes,
        signature_header_present: true,
        signature_timestamp: 1782534490,
        signature_has_v1: true,
        error_type: "StripeSignatureVerificationError",
      }),
    );

    const logFields = (console.warn as jest.Mock).mock.calls[0][1];
    const serializedLogFields = JSON.stringify(logFields);
    expect(serializedLogFields).not.toContain(rawBody);
    expect(serializedLogFields).not.toContain(rawSignature);
    expect(serializedLogFields).not.toContain("user_secret");
    expect(serializedLogFields).not.toContain(
      "24cdc6311e7ea9669746b0e1cd1e8ac53b51ad96070e7919be7172b1dc1e9f30",
    );
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

  it("deactivates referral paid eligibility for deleted HackerAI subscriptions resolved from product fallback", async () => {
    mockGetReferralRewardConfig.mockReturnValue({
      enabled: true,
      referrerRewardDollars: 10,
    });
    mockConstructEvent.mockReturnValue({
      id: "evt_subscription_deleted_hackerai_fallback",
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_hackerai_deleted",
          customer: "cus_hackerai",
          items: {
            data: [
              {
                price: {
                  id: "price_hackerai_no_lookup",
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
    mockRetrieveSubscription.mockResolvedValue({
      id: "sub_hackerai_deleted",
      metadata: {},
      items: {
        data: [
          {
            quantity: 1,
            price: {
              id: "price_hackerai_no_lookup",
              lookup_key: null,
              recurring: { interval: "month", interval_count: 1 },
              product: {
                id: "prod_hackerai_pro_plus",
                name: "HackerAI Pro Plus",
                metadata: {},
              },
            },
          },
        ],
      },
    } as never);
    mockRetrieveCustomer.mockResolvedValue({
      deleted: false,
      id: "cus_hackerai",
      metadata: {
        workOSOrganizationId: "org_hackerai",
      },
    } as never);
    mockListMemberships.mockResolvedValue({
      autoPagination: jest.fn().mockResolvedValue([{ userId: "user_paid" }]),
    } as never);

    const { POST } = await import("../route");

    const response = await POST(makeWebhookRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ received: true });
    expect(mockRetrieveSubscription).toHaveBeenCalledWith(
      "sub_hackerai_deleted",
      {
        expand: ["items.data.price", "items.data.price.product"],
      },
    );
    expect(mockRetrieveCustomer).toHaveBeenCalledWith("cus_hackerai");
    expect(mockListMemberships).toHaveBeenCalledWith({
      organizationId: "org_hackerai",
      statuses: ["active"],
    });
    expect(mockConvexMutation).toHaveBeenCalledWith(
      "referrals.setReferralCodesPaidEligibility",
      {
        serviceKey: "service_key",
        userIds: ["user_paid"],
        active: false,
        subscriptionTier: "free",
      },
    );
    expect(mockPostHogEvent).toHaveBeenCalledWith(
      "subscription_cancelled",
      expect.objectContaining({
        userId: "user_paid",
        tier: "pro-plus",
        org_id: "org_hackerai",
        $set: { subscription_tier: "free" },
      }),
    );
    expect(console.warn).toHaveBeenCalledWith(
      '[Subscription Webhook] Subscription sub_hackerai_deleted missing price lookup_key, resolved tier "pro-plus" from product fallback',
    );
  });

  it("skips deleted legacy PentestGPT subscriptions that do not have a HackerAI price lookup key", async () => {
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
    mockRetrieveSubscription.mockResolvedValue({
      id: "sub_legacy_deleted",
      metadata: {},
      items: {
        data: [
          {
            quantity: 1,
            price: {
              id: "price_legacy",
              lookup_key: null,
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
    expect(mockRetrieveSubscription).toHaveBeenCalledWith(
      "sub_legacy_deleted",
      {
        expand: ["items.data.price", "items.data.price.product"],
      },
    );
    expect(mockRetrieveCustomer).not.toHaveBeenCalled();
    expect(mockListMemberships).not.toHaveBeenCalled();
    expect(mockPostHogEvent).not.toHaveBeenCalledWith(
      "subscription_cancelled",
      expect.anything(),
    );
    expect(console.info).toHaveBeenCalledWith(
      "[Subscription Webhook] subscription.deleted: skipping legacy PentestGPT subscription sub_legacy_deleted for customer cus_migrated",
    );
    expect(mockConvexMutation).not.toHaveBeenCalledWith(
      "referrals.setReferralCodesPaidEligibility",
      expect.anything(),
    );
  });
});
