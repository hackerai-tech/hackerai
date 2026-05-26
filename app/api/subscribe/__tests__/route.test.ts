import { describe, it, expect, jest, beforeEach } from "@jest/globals";

const mockGetUserID = jest.fn();
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
const mockCreateCheckoutSession = jest.fn();
const mockPostHogEvent = jest.fn();
const mockPostHogFlush = jest.fn();

jest.mock("next/server", () => {
  return {
    after: jest.fn((callback: () => void) => callback()),
    NextResponse: {
      json: jest.fn((body: unknown, init?: ResponseInit) => ({
        status: init?.status ?? 200,
        json: async () => body,
      })),
    },
  };
});

jest.mock("@/lib/auth/get-user-id", () => ({
  getUserID: mockGetUserID,
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
    flush: mockPostHogFlush,
  },
}));

function makeRequest(body: Record<string, unknown> = {}) {
  return {
    json: jest.fn().mockResolvedValue(body),
    headers: {
      get: jest.fn().mockReturnValue(null),
    },
  } as any;
}

describe("POST /api/subscribe", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_BASE_URL = "https://hackerai.example";

    mockGetUserID.mockResolvedValue("user_123" as never);
    mockGetUser.mockResolvedValue({
      id: "user_123",
      email: "user@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
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
      error: "Only organization admins can manage billing",
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
    expect(body).toEqual({ url: "https://stripe.example/checkout" });
    expect(mockRetrieveCustomer).toHaveBeenCalledWith("cus_existing_org");
    expect(mockListCustomers).not.toHaveBeenCalled();
    expect(mockCreateCustomer).not.toHaveBeenCalled();
    expect(mockUpdateOrganization).not.toHaveBeenCalled();
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: "cus_existing_org",
        metadata: expect.objectContaining({
          workOSOrganizationId: "org_team",
        }),
      }),
    );
  });
});
