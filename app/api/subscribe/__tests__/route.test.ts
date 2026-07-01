import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { mockMutation as mockConvexMutation } from "convex/browser";

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
          checkoutAttemptId: body.checkoutAttemptId,
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
        checkout_attempt_id: "ca_limit_pressure_123",
        source: "limit_pressure",
        surface: "rate_limit_warning",
        reason: "monthly_exhausted",
        limit_type: "monthly",
      }),
    );
  });
});
