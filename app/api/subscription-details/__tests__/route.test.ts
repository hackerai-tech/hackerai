import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

const mockGetUserID = jest.fn();
const mockGetUser = jest.fn();
const mockListOrganizationMemberships = jest.fn();
const mockGetOrganization = jest.fn();
const mockListCustomers = jest.fn();
const mockListPrices = jest.fn();
const mockListSubscriptions = jest.fn();
const mockCreatePreview = jest.fn();
const mockUpdateSubscription = jest.fn();
const mockPostHogEvent = jest.fn();
const mockPostHogFlush = jest.fn();
const mockClaimCheckoutStarted = jest.fn(async () => true);

jest.mock("@/lib/analytics/paid-funnel-server", () => ({
  claimCheckoutStarted: mockClaimCheckoutStarted,
  paidFunnelEventUuid: jest.fn(
    ({ checkoutAttemptId }: { checkoutAttemptId: string }) =>
      `event_uuid:${checkoutAttemptId}`,
  ),
  paidFunnelIdempotencyKey: jest.fn(
    ({ operation, scopeId, checkoutAttemptId }) =>
      `${operation}:${scopeId}:${checkoutAttemptId}`,
  ),
}));

jest.mock("next/server", () => ({
  after: jest.fn((callback: () => void) => callback()),
  NextResponse: {
    json: jest.fn((body: unknown, init?: ResponseInit) => ({
      status: init?.status ?? 200,
      json: async () => body,
    })),
  },
}));

jest.mock("@/lib/posthog/server", () => ({
  phLogger: {
    event: mockPostHogEvent,
    flush: mockPostHogFlush,
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
    mockClaimCheckoutStarted.mockResolvedValue(true);

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

  afterEach(() => {
    jest.useRealTimers();
  });

  it.each(["pro-plus-monthly-plan", "pro-plus-yearly-plan"])(
    "accepts %s as a target plan",
    async (plan) => {
      const { POST } = await import("../route");

      const response = await POST(makeRequest({ plan }));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.totalDue).toBe(30);
      expect(mockListPrices).toHaveBeenCalledWith({
        lookup_keys: [plan],
      });
    },
  );

  it("allows organization owners to manage billing", async () => {
    mockListOrganizationMemberships.mockResolvedValueOnce({
      data: [
        {
          organizationId: "org_team",
          role: { slug: "owner" },
        },
      ],
    } as never);

    const { POST } = await import("../route");

    const response = await POST(makeRequest({ plan: "pro-monthly-plan" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.totalDue).toBe(30);
    expect(mockListPrices).toHaveBeenCalledWith({
      lookup_keys: ["pro-monthly-plan"],
    });
  });

  it("rejects non-owner, non-admin members from managing billing", async () => {
    mockListOrganizationMemberships.mockResolvedValueOnce({
      data: [
        {
          organizationId: "org_team",
          role: { slug: "member" },
        },
      ],
    } as never);

    const { POST } = await import("../route");

    const response = await POST(makeRequest({ plan: "pro-monthly-plan" }));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      error: "Only organization admins or owners can manage billing",
    });
    expect(mockGetOrganization).not.toHaveBeenCalled();
    expect(mockListPrices).not.toHaveBeenCalled();
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

  it("persists subscription-change attribution in metadata and analytics", async () => {
    const checkoutStartedAt = new Date("2026-07-17T16:30:45.123Z");
    jest.useFakeTimers().setSystemTime(checkoutStartedAt);
    mockListPrices.mockResolvedValue({
      data: [
        {
          id: "price_ultra",
          unit_amount: 10000,
          recurring: { interval: "month", interval_count: 1 },
          currency: "usd",
        },
      ],
    } as never);
    mockListSubscriptions.mockResolvedValue({
      data: [
        {
          id: "sub_123",
          metadata: { existing: "metadata" },
          default_payment_method: null,
          items: {
            data: [
              {
                id: "si_123",
                price: {
                  id: "price_pro",
                  unit_amount: 2000,
                  product: "prod_pro",
                  recurring: { interval: "month" },
                },
              },
            ],
          },
          current_period_start: 1_700_000_000,
          current_period_end: 1_702_592_000,
        },
      ],
    } as never);
    mockCreatePreview.mockResolvedValue({
      amount_due: 8000,
      lines: {
        data: [{ amount: 10000 }, { amount: -2000 }],
      },
    } as never);
    mockUpdateSubscription.mockResolvedValue({
      id: "sub_123",
      latest_invoice: null,
    } as never);

    const { POST } = await import("../route");
    const requestBody = {
      plan: "ultra-monthly-plan",
      confirm: true,
      checkoutAttemptId: "ca_paid_limit_123",
      checkoutAttemptStartedAt: checkoutStartedAt.toISOString(),
      source: "limit_pressure",
      surface: "pricing_dialog",
      reason: "monthly_exhausted",
      limitType: "monthly",
    };
    const response = await POST(makeRequest(requestBody));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockClaimCheckoutStarted).toHaveBeenCalledWith({
      userId: "user_123",
      checkoutAttemptId: "ca_paid_limit_123",
    });
    expect(mockUpdateSubscription).toHaveBeenCalledWith(
      "sub_123",
      expect.objectContaining({
        proration_behavior: "always_invoice",
        payment_behavior: "pending_if_incomplete",
        metadata: expect.objectContaining({
          existing: "metadata",
          checkoutAttemptId: "ca_paid_limit_123",
          checkoutSource: "limit_pressure",
          checkoutSurface: "pricing_dialog",
          checkoutReason: "monthly_exhausted",
          checkoutLimitType: "monthly",
          checkoutType: "subscription_change",
        }),
      }),
      {
        idempotencyKey: "subscription_update:sub_123:ca_paid_limit_123",
      },
    );
    expect(mockUpdateSubscription.mock.calls[0]?.[1]).not.toHaveProperty(
      "proration_date",
    );
    expect(mockPostHogEvent).toHaveBeenCalledWith(
      "checkout_started",
      expect.objectContaining({
        checkout_attempt_id: "ca_paid_limit_123",
        checkout_type: "subscription_change",
        source: "limit_pressure",
        surface: "pricing_dialog",
        reason: "monthly_exhausted",
        limit_type: "monthly",
      }),
      expect.objectContaining({
        uuid: "event_uuid:ca_paid_limit_123",
        timestamp: expect.any(Date),
      }),
    );
    expect(mockPostHogEvent).toHaveBeenCalledWith(
      "checkout_succeeded",
      expect.objectContaining({
        checkout_attempt_id: "ca_paid_limit_123",
        checkout_type: "subscription_change",
        source: "limit_pressure",
        surface: "pricing_dialog",
        reason: "monthly_exhausted",
        limit_type: "monthly",
      }),
    );

    jest.advanceTimersByTime(5_000);
    mockClaimCheckoutStarted.mockResolvedValueOnce(false);

    const replayResponse = await POST(makeRequest(requestBody));

    expect(replayResponse.status).toBe(200);
    expect(mockUpdateSubscription).toHaveBeenCalledTimes(2);
    expect(mockUpdateSubscription.mock.calls[1]?.[2]).toEqual({
      idempotencyKey: "subscription_update:sub_123:ca_paid_limit_123",
    });
    expect(
      mockPostHogEvent.mock.calls.filter(
        ([event]) => event === "checkout_started",
      ),
    ).toHaveLength(1);

    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockUpdateSubscription.mockRejectedValueOnce(
      new Error("card was declined") as never,
    );
    const failedAttemptId = "ca_paid_limit_456";
    const failedResponse = await POST(
      makeRequest({
        ...requestBody,
        checkoutAttemptId: failedAttemptId,
        checkoutAttemptStartedAt: new Date().toISOString(),
      }),
    );

    expect(failedResponse.status).toBe(400);
    expect(
      mockPostHogEvent.mock.calls.filter(
        ([event, properties]) =>
          event === "checkout_started" &&
          properties?.checkout_attempt_id === failedAttemptId,
      ),
    ).toHaveLength(1);
    expect(
      mockPostHogEvent.mock.calls.filter(
        ([event, properties]) =>
          event === "checkout_succeeded" &&
          properties?.checkout_attempt_id === failedAttemptId,
      ),
    ).toHaveLength(0);
    errorSpy.mockRestore();
  });
});
