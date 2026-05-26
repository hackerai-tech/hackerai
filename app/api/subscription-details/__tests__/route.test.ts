import { describe, it, expect, jest, beforeEach } from "@jest/globals";

const mockGetUserID = jest.fn();
const mockGetUser = jest.fn();
const mockListOrganizationMemberships = jest.fn();
const mockGetOrganization = jest.fn();
const mockListCustomers = jest.fn();
const mockListPrices = jest.fn();
const mockListSubscriptions = jest.fn();
const mockCreatePreview = jest.fn();
const mockUpdateSubscription = jest.fn();

jest.mock("next/server", () => ({
  NextResponse: {
    json: jest.fn((body: unknown, init?: ResponseInit) => ({
      status: init?.status ?? 200,
      json: async () => body,
    })),
  },
}));

jest.mock("@/lib/auth/get-user-id", () => ({
  getUserID: mockGetUserID,
}));

jest.mock("../../workos", () => ({
  workos: {
    userManagement: {
      getUser: mockGetUser,
      listOrganizationMemberships: mockListOrganizationMemberships,
    },
    organizations: {
      getOrganization: mockGetOrganization,
    },
  },
}));

jest.mock("../../stripe", () => ({
  stripe: {
    customers: {
      list: mockListCustomers,
    },
    prices: {
      list: mockListPrices,
    },
    subscriptions: {
      list: mockListSubscriptions,
      update: mockUpdateSubscription,
    },
    invoices: {
      createPreview: mockCreatePreview,
    },
    products: {
      retrieve: jest.fn(),
    },
  },
}));

function makeRequest(body: Record<string, unknown> = {}) {
  return {
    json: jest.fn().mockResolvedValue(body),
  } as any;
}

describe("POST /api/subscription-details", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockGetUserID.mockResolvedValue("user_123" as never);
    mockGetUser.mockResolvedValue({
      id: "user_123",
      email: "billing@example.com",
    } as never);
    mockListOrganizationMemberships.mockResolvedValue({
      data: [
        {
          organizationId: "org_team",
          role: { slug: "admin" },
        },
      ],
    } as never);
    mockGetOrganization.mockResolvedValue({ id: "org_team" } as never);
    mockListCustomers.mockResolvedValue({
      data: [
        {
          id: "cus_team",
          metadata: { workOSOrganizationId: "org_team" },
        },
      ],
    } as never);
    mockListPrices.mockResolvedValue({
      data: [
        {
          id: "price_team",
          unit_amount: 3000,
        },
      ],
    } as never);
    mockListSubscriptions.mockResolvedValue({ data: [] } as never);
  });

  it.each([
    ["below the minimum", 1, "Quantity must be a finite integer of at least 2"],
    ["non-integer", 2.5, "Quantity must be a finite integer of at least 2"],
    ["non-finite", Infinity, "Quantity must be a finite integer of at least 2"],
    ["non-number", "999", "Quantity must be a finite integer of at least 2"],
    ["too large", 1000, "Maximum 999 seats allowed"],
  ])("rejects %s team quantities", async (_name, quantity, error) => {
    const { POST } = await import("../route");

    const response = await POST(
      makeRequest({ plan: "team-monthly-plan", quantity }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({ error });
    expect(mockListSubscriptions).not.toHaveBeenCalled();
    expect(mockCreatePreview).not.toHaveBeenCalled();
    expect(mockUpdateSubscription).not.toHaveBeenCalled();
  });

  it("defaults omitted team quantity to two seats", async () => {
    const { POST } = await import("../route");

    const response = await POST(makeRequest({ plan: "team-monthly-plan" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.quantity).toBe(2);
    expect(body.nextInvoiceAmount).toBe(60);
    expect(mockListSubscriptions).toHaveBeenCalledWith({
      customer: "cus_team",
      status: "active",
      limit: 1,
    });
  });
});
