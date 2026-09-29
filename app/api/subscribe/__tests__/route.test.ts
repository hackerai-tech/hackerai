import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import {
  mockQuery as mockConvexQuery,
  mockMutation as mockConvexMutation,
} from "convex/browser";
import { ChatSDKError } from "@/lib/errors";

const mockGetUserIDAndPro = jest.fn();
const mockGetUser = jest.fn();
const mockListOrganizationMemberships = jest.fn();
const mockCreateOrganizationMembership = jest.fn();
const mockGetOrganization = jest.fn();
const mockCreateOrganization = jest.fn();
const mockUpdateOrganization = jest.fn();
const mockListSubscriptions = jest.fn();
const mockRetrieveInvoice = jest.fn();
const mockListInvoicePayments = jest.fn();
const mockListPrices = jest.fn();
const mockListCustomers = jest.fn();
const mockCreateCustomer = jest.fn();
const mockRetrieveCustomer = jest.fn();
const mockUpdateCustomer = jest.fn();
const mockListCheckoutSessions = jest.fn();
const mockUpdateCheckoutSession = jest.fn();
const mockCreateCheckoutSession = jest.fn();
const mockPostHogEvent = jest.fn();
const mockPostHogWarn = jest.fn();
const mockPostHogFlush = jest.fn();
const mockResponseCookieDelete = jest.fn();

jest.mock("next/server", () => {
  return {
    after: jest.fn((callback: () => void) => callback()),
    NextResponse: {
      json: jest.fn((body: unknown, init?: ResponseInit) => ({
        status: init?.status ?? 200,
        json: async () => body,
        cookies: {
          delete: mockResponseCookieDelete,
        },
      })),
    },
  };
});

jest.mock("@/lib/auth/get-user-id", () => ({
  getUserIDAndPro: mockGetUserIDAndPro,
}));

jest.mock("@/app/api/workos", () => ({
  workos: {
    userManagement: {
      getUser: mockGetUser,
      listOrganizationMemberships: mockListOrganizationMemberships,
      createOrganizationMembership: mockCreateOrganizationMembership,
    },
    organizations: {
      getOrganization: mockGetOrganization,
      createOrganization: mockCreateOrganization,
      updateOrganization: mockUpdateOrganization,
    },
  },
}));

jest.mock("@/app/api/stripe", () => ({
  stripe: {
    subscriptions: { list: mockListSubscriptions },
    invoices: { retrieve: mockRetrieveInvoice },
    invoicePayments: { list: mockListInvoicePayments },
    prices: {
      list: mockListPrices,
    },
    customers: {
      list: mockListCustomers,
      create: mockCreateCustomer,
      retrieve: mockRetrieveCustomer,
      update: mockUpdateCustomer,
    },
    checkout: {
      sessions: {
        list: mockListCheckoutSessions,
        update: mockUpdateCheckoutSession,
        create: mockCreateCheckoutSession,
      },
    },
  },
}));

jest.mock("@/lib/posthog/server", () => ({
  phLogger: {
    event: mockPostHogEvent,
    warn: mockPostHogWarn,
    flush: mockPostHogFlush,
  },
}));

function makeRequest(
  body: Record<string, unknown> = {},
  cookies: Record<string, string> = {},
) {
  return {
    json: jest.fn().mockResolvedValue(body),
    headers: {
      get: jest.fn().mockReturnValue(null),
    },
    cookies: {
      get: jest.fn((name: string) =>
        cookies[name] ? { value: cookies[name] } : undefined,
      ),
    },
  } as any;
}

describe("POST /api/subscribe", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_BASE_URL = "https://hackerai.example";
    process.env.CONVEX_SERVICE_ROLE_KEY = "service_key";
    delete process.env.REFERRAL_PROGRAM_ENABLED;

    mockConvexMutation.mockResolvedValue(null);
    mockConvexQuery.mockResolvedValue(null);
    mockListSubscriptions.mockResolvedValue({ data: [] } as never);
    mockListInvoicePayments.mockResolvedValue({ data: [] } as never);

    mockGetUserIDAndPro.mockResolvedValue({
      userId: "user_123",
      subscription: "free",
      freeQuotaSubject: "free_quota_subject",
    } as never);
    mockGetUser.mockResolvedValue({
      id: "user_123",
      email: "user@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      createdAt: "2026-06-30T12:00:00.000Z",
    } as never);
    mockListPrices.mockImplementation(
      async ({ lookup_keys }: { lookup_keys: string[] }) =>
        ({
          data: [
            {
              id:
                lookup_keys[0] === "pro-monthly-plan"
                  ? "price_pro_29"
                  : "price_other",
              lookup_key: lookup_keys[0],
              active: true,
              billing_scheme: "per_unit",
              type: "recurring",
              recurring: {
                interval: "month",
                interval_count: 1,
                usage_type: "licensed",
              },
              unit_amount: lookup_keys[0] === "pro-monthly-plan" ? 2900 : 4900,
              currency: "usd",
            },
          ],
        }) as never,
    );
    mockCreateCheckoutSession.mockResolvedValue({
      id: "cs_123",
      url: "https://stripe.example/checkout",
    } as never);
    mockListCheckoutSessions.mockResolvedValue({ data: [] } as never);
    mockUpdateCheckoutSession.mockImplementation(
      async (
        sessionId: string,
        params: { metadata?: Record<string, string> },
      ) =>
        ({
          id: sessionId,
          url: "https://stripe.example/existing-checkout",
          metadata: params.metadata ?? {},
        }) as never,
    );
    mockUpdateCustomer.mockImplementation(
      async (
        customerId: string,
        params: { metadata?: Record<string, string> },
      ) =>
        ({
          id: customerId,
          metadata: params.metadata ?? {},
        }) as never,
    );
  });

  it("blocks checkout creation while the account has an active dispute hold", async () => {
    mockConvexQuery.mockResolvedValueOnce({
      status: "active",
      category: "dispute_billing_hold",
    });

    const { POST } = await import("../route");
    const response = await POST(makeRequest());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error:
        "Billing is disabled while this account has an active payment dispute or fraud hold. Contact support before making another payment.",
    });
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockCreateCustomer).not.toHaveBeenCalled();
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it("rejects existing organization members who are not billing admins", async () => {
    mockListOrganizationMemberships.mockResolvedValue({
      data: [
        {
          organizationId: "org_team",
          role: { slug: "member" },
        },
      ],
    } as never);

    const { POST } = await import("../route");

    const response = await POST(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      error: "Only organization admins or owners can manage billing",
    });
    expect(mockListOrganizationMemberships).toHaveBeenCalledWith({
      userId: "user_123",
      statuses: ["active"],
    });
    expect(mockGetOrganization).not.toHaveBeenCalled();
    expect(mockCreateCustomer).not.toHaveBeenCalled();
    expect(mockUpdateOrganization).not.toHaveBeenCalled();
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it("scopes checkout creation to the active organization", async () => {
    mockGetUserIDAndPro.mockResolvedValueOnce({
      userId: "user_123",
      subscription: "free",
      organizationId: "org_active",
      freeQuotaSubject: "free_quota_subject",
    } as never);
    mockListOrganizationMemberships.mockResolvedValueOnce({
      data: [
        {
          organizationId: "org_active",
          role: { slug: "admin" },
        },
      ],
    } as never);
    mockGetOrganization.mockResolvedValueOnce({
      id: "org_active",
      stripeCustomerId: "cus_active",
    } as never);
    mockRetrieveCustomer.mockResolvedValueOnce({
      id: "cus_active",
      metadata: { workOSOrganizationId: "org_active" },
    } as never);

    const { POST } = await import("../route");
    const response = await POST(makeRequest({ plan: "pro-monthly-plan" }));

    expect(response.status).toBe(200);
    expect(mockListOrganizationMemberships).toHaveBeenCalledWith({
      userId: "user_123",
      statuses: ["active"],
      organizationId: "org_active",
    });
    expect(mockGetOrganization).toHaveBeenCalledWith("org_active");
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: "cus_active",
        metadata: expect.objectContaining({
          workOSOrganizationId: "org_active",
        }),
      }),
    );
  });

  it("blocks a second checkout when a recently canceled renewal was paid late", async () => {
    const endedAt = Math.floor(Date.now() / 1000) - 120;
    mockListOrganizationMemberships.mockResolvedValueOnce({
      data: [{ organizationId: "org_active", role: { slug: "admin" } }],
    } as never);
    mockGetOrganization.mockResolvedValueOnce({
      id: "org_active",
      stripeCustomerId: "cus_active",
    } as never);
    mockRetrieveCustomer.mockResolvedValueOnce({
      id: "cus_active",
      metadata: { workOSOrganizationId: "org_active" },
    } as never);
    mockListSubscriptions.mockResolvedValueOnce({
      data: [
        {
          id: "sub_old",
          status: "canceled",
          ended_at: endedAt,
          customer: "cus_active",
          latest_invoice: "in_old",
          cancellation_details: { reason: "cancellation_requested" },
        },
      ],
    } as never);
    mockRetrieveInvoice.mockResolvedValueOnce({
      id: "in_old",
      customer: "cus_active",
      parent: { subscription_details: { subscription: "sub_old" } },
      billing_reason: "subscription_cycle",
      collection_method: "charge_automatically",
      status: "paid",
      status_transitions: { paid_at: endedAt + 120 },
    } as never);

    const { POST } = await import("../route");
    const response = await POST(makeRequest({ plan: "pro-plus-monthly-plan" }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        code: "recent_renewal_payment_needs_review",
      }),
    );
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it("rejects ambiguous multi-organization checkout without an active organization", async () => {
    mockListOrganizationMemberships.mockResolvedValueOnce({
      data: [
        { organizationId: "org_a", role: { slug: "admin" } },
        { organizationId: "org_b", role: { slug: "admin" } },
      ],
    } as never);

    const { POST } = await import("../route");
    const response = await POST(makeRequest({ plan: "pro-monthly-plan" }));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: "Select an active organization before subscribing",
      code: "organization_selection_required",
    });
    expect(mockGetOrganization).not.toHaveBeenCalled();
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it("rejects checkout when the active organization membership is stale", async () => {
    mockGetUserIDAndPro.mockResolvedValueOnce({
      userId: "user_123",
      subscription: "free",
      organizationId: "org_stale",
      freeQuotaSubject: "free_quota_subject",
    } as never);
    mockListOrganizationMemberships.mockResolvedValueOnce({
      data: [],
    } as never);

    const { POST } = await import("../route");
    const response = await POST(makeRequest({ plan: "pro-monthly-plan" }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Select an active organization before subscribing",
      code: "organization_selection_required",
    });
    expect(mockListOrganizationMemberships).toHaveBeenCalledWith({
      userId: "user_123",
      statuses: ["active"],
      organizationId: "org_stale",
    });
    expect(mockCreateOrganization).not.toHaveBeenCalled();
    expect(mockCreateOrganizationMembership).not.toHaveBeenCalled();
    expect(mockCreateCustomer).not.toHaveBeenCalled();
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it("returns unauthenticated requests as 401 responses", async () => {
    mockGetUserIDAndPro.mockRejectedValueOnce(
      new ChatSDKError("unauthorized:auth") as never,
    );
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      const { POST } = await import("../route");

      const response = await POST(makeRequest());
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body).toEqual({
        error: "You need to sign in before continuing.",
        code: "unauthorized:auth",
      });
      expect(mockListCheckoutSessions).not.toHaveBeenCalled();
      expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("creates a fresh $29 checkout instead of reusing an open $25 Pro session", async () => {
    mockListOrganizationMemberships.mockResolvedValue({
      data: [{ organizationId: "org_team", role: { slug: "admin" } }],
    } as never);
    mockGetOrganization.mockResolvedValue({
      id: "org_team",
      stripeCustomerId: "cus_existing_org",
    } as never);
    mockRetrieveCustomer.mockResolvedValue({
      id: "cus_existing_org",
      metadata: { workOSOrganizationId: "org_team" },
    } as never);
    mockListCheckoutSessions.mockResolvedValue({
      data: [
        {
          id: "cs_old_25",
          url: "https://stripe.example/old-checkout",
          success_url: "https://hackerai.example/?refresh=entitlements",
          cancel_url: "https://hackerai.example/",
          metadata: {
            workOSOrganizationId: "org_team",
            requestedPlan: "pro-monthly-plan",
            resolvedPriceLookupKey: "pro-monthly-plan",
          },
        },
      ],
      has_more: false,
    } as never);
    const { POST } = await import("../route");
    const response = await POST(makeRequest({ plan: "pro-monthly-plan" }));
    expect(response.status).toBe(200);
    expect(mockUpdateCheckoutSession).not.toHaveBeenCalled();
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [{ price: "price_pro_29", quantity: 1 }],
      }),
    );
  });

  it("returns Preview checkout to its branch and rejects a matching session from another branch", async () => {
    const originalEnv = {
      VERCEL: process.env.VERCEL,
      VERCEL_ENV: process.env.VERCEL_ENV,
      VERCEL_BRANCH_URL: process.env.VERCEL_BRANCH_URL,
      VERCEL_URL: process.env.VERCEL_URL,
    };
    Object.assign(process.env, {
      VERCEL: "1",
      VERCEL_ENV: "preview",
      VERCEL_BRANCH_URL: "hackerai-git-regional-hackerai.vercel.app",
      VERCEL_URL: "hackerai-regional-deployment-hackerai.vercel.app",
    });
    mockListOrganizationMemberships.mockResolvedValue({
      data: [{ organizationId: "org_team", role: { slug: "admin" } }],
    } as never);
    mockGetOrganization.mockResolvedValue({
      id: "org_team",
      stripeCustomerId: "cus_existing_org",
    } as never);
    mockRetrieveCustomer.mockResolvedValue({
      id: "cus_existing_org",
      metadata: { workOSOrganizationId: "org_team" },
    } as never);
    mockListCheckoutSessions.mockResolvedValue({
      data: [
        {
          id: "cs_stale_branch",
          url: "https://stripe.example/stale-checkout",
          success_url: "https://hackerai.example/?refresh=entitlements",
          cancel_url: "https://hackerai.example/",
          metadata: {
            workOSOrganizationId: "org_team",
            requestedPlan: "pro-monthly-plan",
            resolvedPriceLookupKey: "pro-monthly-plan",
            pricingExperimentKey: "hac46-pro-monthly-29-pricing",
            pricingExperimentVariant: "control",
            pricingExperimentPriceLookupKey: "pro-monthly-plan",
          },
        },
      ],
      has_more: false,
    } as never);
    try {
      const { POST } = await import("../route");
      const request = makeRequest({ plan: "pro-monthly-plan" });
      request.nextUrl = new URL(
        "https://hackerai-regional-deployment-hackerai.vercel.app",
      );
      const response = await POST(request);
      expect(response.status).toBe(200);
      expect(mockUpdateCheckoutSession).not.toHaveBeenCalled();
      expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({
          success_url:
            "https://hackerai-regional-deployment-hackerai.vercel.app/?refresh=entitlements",
          cancel_url:
            "https://hackerai-regional-deployment-hackerai.vercel.app/",
        }),
      );
    } finally {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("returns a safe conflict response when Stripe's pending-session limit is reached", async () => {
    mockListOrganizationMemberships.mockResolvedValue({
      data: [
        {
          organizationId: "org_team",
          role: { slug: "admin" },
        },
      ],
    } as never);
    mockGetOrganization.mockResolvedValue({
      id: "org_team",
      stripeCustomerId: "cus_existing_org",
    } as never);
    mockRetrieveCustomer.mockResolvedValue({
      id: "cus_existing_org",
      metadata: { workOSOrganizationId: "org_team" },
    } as never);
    const stripeError = Object.assign(
      new Error("Customer reached the pending Checkout Session limit"),
      {
        code: "customer_max_subscriptions",
        requestId: "req_stripe_123",
      },
    );
    mockCreateCheckoutSession.mockRejectedValueOnce(stripeError as never);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      const { POST } = await import("../route");

      const response = await POST(makeRequest({ plan: "pro-monthly-plan" }));
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body).toEqual({
        error:
          "A checkout is already pending. Please resume it or contact support if the problem continues.",
      });
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const log = JSON.parse(String(errorSpy.mock.calls[0]?.[0]));
      expect(log).toMatchObject({
        event: "billing.subscribe_request_failed",
        service: "hackerai-web",
        route: "/api/subscribe",
        stripe_error_code: "customer_max_subscriptions",
        stripe_request_id: "req_stripe_123",
      });
      expect(log).not.toHaveProperty("customer_id");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("uses an existing organization Stripe customer instead of replacing it", async () => {
    mockListOrganizationMemberships.mockResolvedValue({
      data: [
        {
          organizationId: "org_team",
          role: { slug: "admin" },
        },
      ],
    } as never);
    mockGetOrganization.mockResolvedValue({
      id: "org_team",
      stripeCustomerId: "cus_existing_org",
    } as never);
    mockRetrieveCustomer.mockResolvedValue({
      id: "cus_existing_org",
      metadata: {},
    } as never);

    const { POST } = await import("../route");

    const response = await POST(makeRequest({ plan: "team-monthly-plan" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(
      expect.objectContaining({
        url: "https://stripe.example/checkout",
        checkoutAttemptId: expect.stringMatching(/^ca_/),
      }),
    );
    expect(mockRetrieveCustomer).toHaveBeenCalledWith("cus_existing_org");
    expect(mockUpdateCustomer).toHaveBeenCalledWith("cus_existing_org", {
      metadata: {
        workOSOrganizationId: "org_team",
      },
    });
    expect(mockListCustomers).not.toHaveBeenCalled();
    expect(mockCreateCustomer).not.toHaveBeenCalled();
    expect(mockUpdateOrganization).not.toHaveBeenCalled();
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: "cus_existing_org",
        metadata: expect.objectContaining({
          workOSOrganizationId: "org_team",
          checkoutQuantity: "1",
          checkoutAttemptId: body.checkoutAttemptId,
        }),
        subscription_data: expect.objectContaining({
          metadata: expect.objectContaining({ checkoutQuantity: "1" }),
        }),
      }),
    );
  });

  it("persists a metadata-matched Stripe customer onto the organization", async () => {
    mockListOrganizationMemberships.mockResolvedValue({
      data: [
        {
          organizationId: "org_team",
          role: { slug: "owner" },
        },
      ],
    } as never);
    mockGetOrganization.mockResolvedValue({
      id: "org_team",
    } as never);
    mockListCustomers.mockResolvedValue({
      data: [
        {
          id: "cus_matched",
          metadata: {
            workOSOrganizationId: "org_team",
          },
        },
      ],
    } as never);

    const { POST } = await import("../route");

    const response = await POST(makeRequest({ plan: "team-monthly-plan" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(
      expect.objectContaining({
        url: "https://stripe.example/checkout",
        checkoutAttemptId: expect.stringMatching(/^ca_/),
      }),
    );
    expect(mockCreateCustomer).not.toHaveBeenCalled();
    expect(mockUpdateOrganization).toHaveBeenCalledWith({
      organization: "org_team",
      stripeCustomerId: "cus_matched",
    });
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: "cus_matched",
        metadata: expect.objectContaining({
          checkoutAttemptId: body.checkoutAttemptId,
        }),
      }),
    );
  });

  it("retries a timed-out WorkOS organization update once", async () => {
    mockListOrganizationMemberships.mockResolvedValue({
      data: [
        {
          organizationId: "org_team",
          role: { slug: "owner" },
        },
      ],
    } as never);
    mockGetOrganization.mockResolvedValue({ id: "org_team" } as never);
    mockListCustomers.mockResolvedValue({
      data: [
        {
          id: "cus_matched",
          metadata: { workOSOrganizationId: "org_team" },
        },
      ],
    } as never);
    const timeout = Object.assign(new Error("Error: Request timeout"), {
      name: "OauthException",
    });
    mockUpdateOrganization
      .mockRejectedValueOnce(timeout as never)
      .mockResolvedValueOnce(undefined as never);
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const { POST } = await import("../route");

      const response = await POST(makeRequest({ plan: "pro-monthly-plan" }));

      expect(response.status).toBe(200);
      expect(mockUpdateOrganization).toHaveBeenCalledTimes(2);
      expect(mockUpdateOrganization).toHaveBeenNthCalledWith(1, {
        organization: "org_team",
        stripeCustomerId: "cus_matched",
      });
      expect(JSON.parse(String(warnSpy.mock.calls[0]?.[0]))).toMatchObject({
        event: "billing.workos_organization_update_retry_scheduled",
        request_id: "unknown",
        service: "hackerai-web",
        route: "/api/subscribe",
        user_id: "user_123",
        organization_id: "org_team",
        stripe_customer_id: "cus_matched",
        attempt: 1,
        next_attempt: 2,
        retry_delay_ms: 0,
        workos_error_name: "OauthException",
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("records referral checkout linkage without copying referral data into Stripe metadata", async () => {
    mockListOrganizationMemberships.mockResolvedValue({
      data: [],
    } as never);
    mockCreateOrganization.mockResolvedValue({
      id: "org_new",
    } as never);
    mockCreateCustomer.mockResolvedValue({
      id: "cus_new",
      metadata: {},
    } as never);
    mockConvexMutation
      .mockResolvedValueOnce({
        status: "attributed",
        referrerUserId: "user_referrer",
        starterBonusAwarded: false,
      } as never)
      .mockResolvedValueOnce({
        recorded: true,
        referrerUserId: "user_referrer",
        referralCode: "REF123",
      } as never);

    const { POST } = await import("../route");

    const response = await POST(
      makeRequest({ plan: "pro-monthly-plan" }, { hackerai_ref: "REF123" }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(
      expect.objectContaining({
        url: "https://stripe.example/checkout",
        checkoutAttemptId: expect.stringMatching(/^ca_/),
      }),
    );
    expect(mockConvexMutation).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        serviceKey: "service_key",
        referredUserId: "user_123",
        referralCode: "REF123",
        starterBonusUnits: 0,
        referredIdentityHash: "free_quota_subject",
        source: "subscribe_route_referral_cookie",
      }),
    );
    expect(mockConvexMutation).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        serviceKey: "service_key",
        referredUserId: "user_123",
        stripeCustomerId: "cus_new",
        stripeCheckoutSessionId: "cs_123",
        requestedPlan: "pro-monthly-plan",
      }),
    );
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          userId: "user_123",
          workOSOrganizationId: "org_new",
          requestedPlan: "pro-monthly-plan",
          checkoutAttemptId: body.checkoutAttemptId,
        }),
        subscription_data: expect.objectContaining({
          metadata: expect.objectContaining({
            userId: "user_123",
            workOSOrganizationId: "org_new",
            requestedPlan: "pro-monthly-plan",
            checkoutAttemptId: body.checkoutAttemptId,
          }),
        }),
      }),
    );
    const checkoutArgs = mockCreateCheckoutSession.mock.calls[0]?.[0] as any;
    expect(checkoutArgs.client_reference_id).toBeUndefined();
    expect(checkoutArgs.metadata).not.toHaveProperty("referral_code");
    expect(checkoutArgs.metadata).not.toHaveProperty(
      "referral_referred_user_id",
    );
    expect(checkoutArgs.subscription_data.metadata).not.toHaveProperty(
      "referral_code",
    );
    expect(checkoutArgs.subscription_data.metadata).not.toHaveProperty(
      "referral_referred_user_id",
    );
  });

  it("skips referral attribution and checkout linkage for paid users", async () => {
    mockGetUserIDAndPro.mockResolvedValueOnce({
      userId: "user_123",
      subscription: "pro",
      freeQuotaSubject: "free_quota_subject",
    } as never);
    mockListOrganizationMemberships.mockResolvedValue({
      data: [],
    } as never);
    mockCreateOrganization.mockResolvedValue({
      id: "org_new",
    } as never);
    mockCreateCustomer.mockResolvedValue({
      id: "cus_new",
      metadata: {},
    } as never);

    const { POST } = await import("../route");

    const response = await POST(
      makeRequest({ plan: "pro-monthly-plan" }, { hackerai_ref: "REF123" }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      url: "https://stripe.example/checkout",
      checkoutAttemptId: expect.stringMatching(/^ca_/),
    });
    expect(mockConvexMutation).not.toHaveBeenCalled();
    expect(mockResponseCookieDelete).toHaveBeenCalledWith("hackerai_ref");
    expect(mockResponseCookieDelete).toHaveBeenCalledWith("hackerai_ref_at");
  });

  it("clears paid-user referral cookies when referral attribution is disabled", async () => {
    process.env.REFERRAL_PROGRAM_ENABLED = "false";
    mockGetUserIDAndPro.mockResolvedValueOnce({
      userId: "user_123",
      subscription: "pro",
      freeQuotaSubject: "free_quota_subject",
    } as never);
    mockListOrganizationMemberships.mockResolvedValue({
      data: [],
    } as never);
    mockCreateOrganization.mockResolvedValue({
      id: "org_new",
    } as never);
    mockCreateCustomer.mockResolvedValue({
      id: "cus_new",
      metadata: {},
    } as never);

    const { POST } = await import("../route");

    const response = await POST(
      makeRequest({ plan: "pro-monthly-plan" }, { hackerai_ref: "REF123" }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      url: "https://stripe.example/checkout",
      checkoutAttemptId: expect.stringMatching(/^ca_/),
    });
    expect(mockConvexMutation).not.toHaveBeenCalled();
    expect(mockResponseCookieDelete).toHaveBeenCalledWith("hackerai_ref");
    expect(mockResponseCookieDelete).toHaveBeenCalledWith("hackerai_ref_at");
  });

  it("persists checkout attribution in Stripe metadata and analytics", async () => {
    mockListOrganizationMemberships.mockResolvedValue({
      data: [],
    } as never);
    mockCreateOrganization.mockResolvedValue({
      id: "org_new",
    } as never);
    mockCreateCustomer.mockResolvedValue({
      id: "cus_new",
      metadata: {},
    } as never);

    const { POST } = await import("../route");

    const response = await POST(
      makeRequest({
        plan: "pro-plus-monthly-plan",
        checkoutAttemptId: "ca_limit_pressure_123",
        source: "limit_pressure",
        surface: "rate_limit_warning",
        reason: "monthly_exhausted",
        limitType: "monthly",
        fromTier: "free",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.checkoutAttemptId).toBe("ca_limit_pressure_123");
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          checkoutAttemptId: "ca_limit_pressure_123",
          checkoutSource: "limit_pressure",
          checkoutSurface: "rate_limit_warning",
          checkoutReason: "monthly_exhausted",
          checkoutLimitType: "monthly",
        }),
        subscription_data: expect.objectContaining({
          metadata: expect.objectContaining({
            checkoutAttemptId: "ca_limit_pressure_123",
            checkoutSource: "limit_pressure",
            checkoutSurface: "rate_limit_warning",
            checkoutReason: "monthly_exhausted",
            checkoutLimitType: "monthly",
          }),
        }),
      }),
    );
    expect(mockPostHogEvent).toHaveBeenCalledWith(
      "checkout_started",
      expect.objectContaining({
        eventUuid: expect.stringMatching(/^[0-9a-f-]{36}$/i),
        checkout_attempt_id: "ca_limit_pressure_123",
        source: "limit_pressure",
        surface: "rate_limit_warning",
        reason: "monthly_exhausted",
        limit_type: "monthly",
        $insert_id: "checkout_started:ca_limit_pressure_123",
      }),
    );
  });

  it("uses the $29 Stripe Price for every new Pro monthly checkout", async () => {
    mockListOrganizationMemberships.mockResolvedValue({ data: [] } as never);
    mockCreateOrganization.mockResolvedValue({ id: "org_new" } as never);
    mockCreateCustomer.mockResolvedValue({
      id: "cus_new",
      metadata: {},
    } as never);
    const { POST } = await import("../route");
    const response = await POST(makeRequest({ plan: "pro-monthly-plan" }));
    expect(response.status).toBe(200);
    expect(mockListPrices).toHaveBeenCalledWith({
      lookup_keys: ["pro-monthly-plan"],
    });
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [{ price: "price_pro_29", quantity: 1 }],
        metadata: expect.objectContaining({
          resolvedPriceLookupKey: "pro-monthly-plan",
        }),
      }),
    );
    expect(mockPostHogEvent).toHaveBeenCalledWith(
      "checkout_started",
      expect.objectContaining({
        plan: "pro-monthly-plan",
        stripe_price_lookup_key: "pro-monthly-plan",
        charged_amount_dollars: 29,
        stripe_price_id: "price_pro_29",
      }),
    );
  });

  it("fails closed if Pro monthly lookup still resolves to $25", async () => {
    mockListOrganizationMemberships.mockResolvedValue({ data: [] } as never);
    mockCreateOrganization.mockResolvedValue({ id: "org_new" } as never);
    mockListPrices.mockResolvedValue({
      data: [
        {
          id: "price_pro_25",
          lookup_key: "pro-monthly-plan",
          active: true,
          billing_scheme: "per_unit",
          type: "recurring",
          recurring: {
            interval: "month",
            interval_count: 1,
            usage_type: "licensed",
          },
          unit_amount: 2500,
          currency: "usd",
        },
      ],
    } as never);
    const { POST } = await import("../route");
    const response = await POST(makeRequest({ plan: "pro-monthly-plan" }));
    expect(response.status).toBe(503);
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it("does not accept the retired experimental lookup key from the client", async () => {
    mockListOrganizationMemberships.mockResolvedValue({ data: [] } as never);
    mockCreateOrganization.mockResolvedValue({ id: "org_new" } as never);
    mockCreateCustomer.mockResolvedValue({
      id: "cus_new",
      metadata: {},
    } as never);
    const { POST } = await import("../route");
    const response = await POST(
      makeRequest({ plan: "pro-monthly-plan-29-experiment" }),
    );
    expect(response.status).toBe(200);
    expect(mockListPrices).toHaveBeenCalledWith({
      lookup_keys: ["pro-monthly-plan"],
    });
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [{ price: "price_pro_29", quantity: 1 }],
      }),
    );
  });

  it("retries an idempotent Stripe customer read after a lock timeout", async () => {
    mockListOrganizationMemberships.mockResolvedValue({
      data: [
        {
          organizationId: "org_team",
          role: { slug: "owner" },
        },
      ],
    } as never);
    mockGetOrganization.mockResolvedValue({
      id: "org_team",
      stripeCustomerId: "cus_existing_org",
    } as never);
    const lockTimeout = Object.assign(new Error("Stripe object is locked"), {
      code: "lock_timeout",
      requestId: "req_lock_timeout",
    });
    mockRetrieveCustomer
      .mockRejectedValueOnce(lockTimeout as never)
      .mockResolvedValueOnce({
        id: "cus_existing_org",
        metadata: { workOSOrganizationId: "org_team" },
      } as never);
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const { POST } = await import("../route");

      const response = await POST(makeRequest({ plan: "pro-monthly-plan" }));

      expect(response.status).toBe(200);
      expect(mockRetrieveCustomer).toHaveBeenCalledTimes(2);
      expect(JSON.parse(String(warnSpy.mock.calls[0]?.[0]))).toMatchObject({
        event: "billing.stripe_customer_retrieve_retry_scheduled",
        request_id: "unknown",
        service: "hackerai-web",
        route: "/api/subscribe",
        user_id: "user_123",
        organization_id: "org_team",
        stripe_customer_id: "cus_existing_org",
        stripe_error_code: "lock_timeout",
        stripe_request_id: "req_lock_timeout",
        attempt: 1,
        next_attempt: 2,
        retry_delay_ms: 0,
      });
    } finally {
      warnSpy.mockRestore();
    }
  });
  it("binds an influencer customer before creating the checkout session", async () => {
    const { POST } = await import("../route");
    mockGetUserIDAndPro.mockResolvedValue({
      userId: "user_123",
      subscription: "free",
      organizationId: "org_team",
      freeQuotaSubject: "free_quota:v1:customer",
    } as never);
    mockGetOrganization.mockResolvedValue({
      id: "org_team",
      name: "Team",
      stripeCustomerId: "cus_existing",
    } as never);
    mockListOrganizationMemberships.mockResolvedValue({
      data: [
        {
          id: "membership_1",
          userId: "user_123",
          organizationId: "org_team",
          role: { slug: "admin" },
        },
      ],
    } as never);
    mockRetrieveCustomer.mockResolvedValue({
      id: "cus_existing",
      metadata: { workOSOrganizationId: "org_team" },
    } as never);
    mockConvexQuery.mockResolvedValue({ _id: "attribution_1" });
    const response = await POST(makeRequest({ plan: "pro-monthly-plan" }));
    expect(response.status).toBe(200);
    expect(mockListSubscriptions).toHaveBeenCalledWith({
      customer: "cus_existing",
      status: "all",
      limit: 1,
    });
    const binding = mockConvexMutation.mock.calls.findIndex(
      (call: any[]) =>
        call[1]?.identity === "free_quota:v1:customer" &&
        call[1]?.customerId === "cus_existing",
    );
    expect(binding).toBeGreaterThanOrEqual(0);
    expect(mockConvexMutation.mock.invocationCallOrder[binding]).toBeLessThan(
      mockCreateCheckoutSession.mock.invocationCallOrder[0],
    );
  });
});
