import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { mockMutation as mockConvexMutation } from "convex/browser";
import { ChatSDKError } from "@/lib/errors";

const mockGetUserIDAndPro = jest.fn();
const mockGetUser = jest.fn();
const mockListOrganizationMemberships = jest.fn();
const mockCreateOrganizationMembership = jest.fn();
const mockGetOrganization = jest.fn();
const mockCreateOrganization = jest.fn();
const mockUpdateOrganization = jest.fn();
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
    mockListPrices.mockResolvedValue({
      data: [
        {
          id: "price_pro",
          recurring: { interval: "month", interval_count: 1 },
          unit_amount: 2000,
          currency: "usd",
        },
      ],
    } as never);
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

  it("reuses a matching legacy open Checkout Session", async () => {
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
    mockListCheckoutSessions
      .mockResolvedValueOnce({
        data: [
          {
            id: "cs_other_plan",
            url: "https://stripe.example/other-checkout",
            metadata: {
              workOSOrganizationId: "org_team",
              requestedPlan: "team-monthly-plan",
            },
          },
        ],
        has_more: true,
      } as never)
      .mockResolvedValueOnce({
        data: [
          {
            id: "cs_open",
            url: "https://stripe.example/existing-checkout",
            metadata: {
              workOSOrganizationId: "org_team",
              requestedPlan: "pro-monthly-plan",
              checkoutAttemptId: "ca_original",
            },
          },
        ],
        has_more: false,
      } as never);
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const { POST } = await import("../route");

      const response = await POST(
        makeRequest({
          plan: "pro-monthly-plan",
          checkoutAttemptId: "ca_retry_123",
        }),
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({
        url: "https://stripe.example/existing-checkout",
        checkoutAttemptId: "ca_retry_123",
      });
      expect(mockListCheckoutSessions).toHaveBeenNthCalledWith(1, {
        customer: "cus_existing_org",
        status: "open",
        limit: 100,
      });
      expect(mockListCheckoutSessions).toHaveBeenNthCalledWith(2, {
        customer: "cus_existing_org",
        status: "open",
        limit: 100,
        starting_after: "cs_other_plan",
      });
      expect(mockUpdateCheckoutSession).toHaveBeenCalledWith("cs_open", {
        metadata: {
          workOSOrganizationId: "org_team",
          requestedPlan: "pro-monthly-plan",
          checkoutAttemptId: "ca_retry_123",
          userId: "user_123",
          checkoutQuantity: "1",
          checkoutType: "new_subscription",
        },
      });
      expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(warnSpy.mock.calls[0]?.[0]))).toMatchObject({
        event: "billing.checkout_session_reused",
        service: "hackerai-web",
        route: "/api/subscribe",
        stripe_customer_id: "cus_existing_org",
        stripe_checkout_session_id: "cs_open",
        checkout_attempt_id: "ca_retry_123",
        previous_checkout_attempt_id: "ca_original",
      });
      expect(mockPostHogEvent).toHaveBeenCalledWith(
        "checkout_started",
        expect.objectContaining({
          eventUuid: expect.stringMatching(/^[0-9a-f-]{36}$/i),
          checkout_attempt_id: "ca_retry_123",
          stripe_checkout_session_id: "cs_open",
          stripe_checkout_session_reused: true,
          $insert_id: "checkout_started:ca_retry_123",
        }),
      );
    } finally {
      warnSpy.mockRestore();
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
    expect(body).toEqual({
      url: "https://stripe.example/checkout",
      checkoutAttemptId: expect.stringMatching(/^ca_/),
    });
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
    expect(body).toEqual({
      url: "https://stripe.example/checkout",
      checkoutAttemptId: expect.stringMatching(/^ca_/),
    });
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
    expect(body).toEqual({
      url: "https://stripe.example/checkout",
      checkoutAttemptId: expect.stringMatching(/^ca_/),
    });
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
});
