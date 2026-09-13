import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

const mockConstructEvent = jest.fn();
const mockListSubscriptions = jest.fn();
const mockCancelSubscription = jest.fn();
const mockListPaymentMethods = jest.fn();
const mockDetachPaymentMethod = jest.fn();
const mockUpdateCustomer = jest.fn();
const mockRetrieveCharge = jest.fn();
const mockUpdateCharge = jest.fn();
const mockConvexMutation = jest.fn();
const mockResolveUserIdsFromCustomer = jest.fn();

jest.mock("next/server", () => ({
  NextResponse: {
    json: jest.fn((body: unknown, init?: ResponseInit) => ({
      status: init?.status ?? 200,
      json: async () => body,
    })),
  },
}));

jest.mock("@/app/api/stripe", () => ({
  stripe: {
    webhooks: { constructEvent: mockConstructEvent },
    subscriptions: {
      list: mockListSubscriptions,
      cancel: mockCancelSubscription,
    },
    paymentMethods: {
      list: mockListPaymentMethods,
      detach: mockDetachPaymentMethod,
    },
    customers: { update: mockUpdateCustomer },
    charges: {
      retrieve: mockRetrieveCharge,
      update: mockUpdateCharge,
    },
  },
}));

jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({ mutation: mockConvexMutation }),
}));

jest.mock("@/convex/_generated/api", () => ({
  api: {
    extraUsage: {
      claimWebhookProcessing: "extraUsage.claimWebhookProcessing",
      finalizeWebhookProcessing: "extraUsage.finalizeWebhookProcessing",
    },
    userSuspensions: { upsertActive: "userSuspensions.upsertActive" },
  },
}));

jest.mock("@/lib/billing/resolve-customer-users", () => ({
  resolveUserIdsFromCustomer: mockResolveUserIdsFromCustomer,
}));

jest.mock("@/lib/billing/stripe-webhook-logging", () => ({
  logStripeWebhookMissingSignature: jest.fn(),
  logStripeWebhookSignatureVerificationFailed: jest.fn(),
}));

const missingCustomerError = {
  type: "StripeInvalidRequestError",
  code: "resource_missing",
  message: "No such customer: 'cus_deleted'",
};

const transientStripeError = {
  type: "StripeAPIError",
  code: "api_error",
  message: "Stripe is temporarily unavailable",
};

type CustomerBoundary =
  "subscriptions.list" | "paymentMethods.list" | "customers.update";

function makeRequest() {
  return {
    text: jest.fn().mockResolvedValue("signed-body"),
    headers: {
      get: jest.fn((name: string) =>
        name === "stripe-signature" ? "sig_test" : null,
      ),
    },
  } as any;
}

function rejectBoundary(boundary: CustomerBoundary, error: unknown) {
  if (boundary === "subscriptions.list") {
    mockListSubscriptions.mockRejectedValue(error as never);
  } else if (boundary === "paymentMethods.list") {
    mockListPaymentMethods.mockRejectedValue(error as never);
  } else {
    mockUpdateCustomer.mockRejectedValue(error as never);
  }
}

describe("POST /api/fraud/webhook", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.STRIPE_FRAUD_WEBHOOK_SECRET = "whsec_test";
    process.env.CONVEX_SERVICE_ROLE_KEY = "service_role_test";

    mockConstructEvent.mockReturnValue({
      id: "evt_dispute",
      type: "charge.dispute.created",
      data: {
        object: {
          id: "dp_fraudulent",
          reason: "fraudulent",
          amount: 4200,
          charge: "ch_disputed",
          created: 1_788_000_000,
        },
      },
    });
    mockRetrieveCharge.mockResolvedValue({
      id: "ch_disputed",
      customer: "cus_deleted",
    } as never);
    mockResolveUserIdsFromCustomer.mockResolvedValue({
      userIds: ["user_opaque"],
      orgId: "org_opaque",
    } as never);
    mockListSubscriptions.mockResolvedValue({ data: [] } as never);
    mockListPaymentMethods.mockResolvedValue({ data: [] } as never);
    mockUpdateCustomer.mockResolvedValue({ id: "cus_deleted" } as never);
    mockUpdateCharge.mockResolvedValue({ id: "ch_disputed" } as never);
    mockConvexMutation.mockImplementation(async (operation: unknown) => {
      if (operation === "extraUsage.claimWebhookProcessing") {
        return { state: "acquired" };
      }
      return undefined;
    });

    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each<CustomerBoundary>([
    "subscriptions.list",
    "paymentMethods.list",
    "customers.update",
  ])(
    "treats a missing customer at %s as terminal and completes the dispute",
    async (boundary) => {
      rejectBoundary(boundary, missingCustomerError);

      const { POST } = await import("../route");
      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(mockConvexMutation).toHaveBeenCalledWith(
        "userSuspensions.upsertActive",
        expect.objectContaining({
          userId: "user_opaque",
          category: "dispute_fraudulent",
          sourceId: "dp_fraudulent",
          stripeCustomerId: "cus_deleted",
        }),
      );
      expect(mockUpdateCharge).toHaveBeenCalledWith("ch_disputed", {
        fraud_details: { user_report: "fraudulent" },
      });
      expect(mockConvexMutation).toHaveBeenCalledWith(
        "extraUsage.finalizeWebhookProcessing",
        expect.objectContaining({ eventId: "evt_dispute" }),
      );

      const suspensionCall = mockConvexMutation.mock.calls.findIndex(
        ([operation]) => operation === "userSuspensions.upsertActive",
      );
      expect(suspensionCall).toBeGreaterThanOrEqual(0);
      expect(
        mockConvexMutation.mock.invocationCallOrder[suspensionCall],
      ).toBeLessThan(mockListSubscriptions.mock.invocationCallOrder[0]!);
    },
  );

  it.each<CustomerBoundary>([
    "subscriptions.list",
    "paymentMethods.list",
    "customers.update",
  ])("keeps a transient error at %s retriable", async (boundary) => {
    rejectBoundary(boundary, transientStripeError);

    const { POST } = await import("../route");
    const response = await POST(makeRequest());

    expect(response.status).toBe(500);
    expect(mockConvexMutation).toHaveBeenCalledWith(
      "userSuspensions.upsertActive",
      expect.any(Object),
    );
    expect(mockConvexMutation).not.toHaveBeenCalledWith(
      "extraUsage.finalizeWebhookProcessing",
      expect.any(Object),
    );
  });

  it("applies a non-fraudulent billing hold before terminal cleanup", async () => {
    mockConstructEvent.mockReturnValue({
      id: "evt_dispute_non_fraudulent",
      type: "charge.dispute.created",
      data: {
        object: {
          id: "dp_duplicate",
          reason: "duplicate",
          amount: 4200,
          charge: "ch_disputed",
          created: 1_788_000_000,
        },
      },
    });
    mockListSubscriptions.mockRejectedValue(missingCustomerError as never);

    const { POST } = await import("../route");
    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockConvexMutation).toHaveBeenCalledWith(
      "userSuspensions.upsertActive",
      expect.objectContaining({
        category: "dispute_billing_hold",
        sourceId: "dp_duplicate",
      }),
    );
    expect(mockUpdateCustomer).not.toHaveBeenCalled();
    expect(mockUpdateCharge).not.toHaveBeenCalled();

    const suspensionCall = mockConvexMutation.mock.calls.findIndex(
      ([operation]) => operation === "userSuspensions.upsertActive",
    );
    expect(
      mockConvexMutation.mock.invocationCallOrder[suspensionCall],
    ).toBeLessThan(mockListSubscriptions.mock.invocationCallOrder[0]!);
  });
});
