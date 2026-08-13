import { describe, expect, it, jest, beforeEach } from "@jest/globals";

const mockRedirectToBillingPortal = jest.fn();
const mockGetSubscriptionCancellationStatus = jest.fn();
const mockKeepSubscription = jest.fn();
const mockCancelSubscription = jest.fn();

jest.mock("@/lib/actions/billing-portal", () => ({
  __esModule: true,
  default: mockRedirectToBillingPortal,
}));

jest.mock("@/lib/actions/subscription-status", () => ({
  __esModule: true,
  default: mockGetSubscriptionCancellationStatus,
}));

jest.mock("@/lib/actions/keep-subscription", () => ({
  __esModule: true,
  default: mockKeepSubscription,
}));

jest.mock("@/lib/actions/cancel-subscription", () => ({
  __esModule: true,
  default: mockCancelSubscription,
}));

jest.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

function request(body: unknown) {
  return {
    json: async () => body,
  };
}

function unreadableJsonRequest() {
  return {
    json: async () => {
      throw new SyntaxError("Invalid JSON");
    },
  };
}

describe("billing API routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns a billing portal URL", async () => {
    mockRedirectToBillingPortal.mockResolvedValue(
      "https://billing.stripe.com/session" as never,
    );
    const { POST } = await import("../portal/route");

    const response = await POST(request(null) as never);

    await expect(response.json()).resolves.toEqual({
      url: "https://billing.stripe.com/session",
    });
    expect(response.status).toBe(200);
  });

  it("maps expected billing errors to JSON responses", async () => {
    mockRedirectToBillingPortal.mockRejectedValue(
      new Error("Only admins or owners can manage billing") as never,
    );
    const { POST } = await import("../portal/route");

    const response = await POST(request(null) as never);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Only admins or owners can manage billing",
    });
  });

  it("passes payment method update mode to the billing portal action", async () => {
    mockRedirectToBillingPortal.mockResolvedValue(
      "https://billing.stripe.com/payment-method" as never,
    );
    const { POST } = await import("../portal/route");

    const response = await POST(request({ flow: "payment_method" }) as never);

    expect(response.status).toBe(200);
    expect(mockRedirectToBillingPortal).toHaveBeenCalledWith("payment_method");
  });

  it("rejects unsupported billing portal flows", async () => {
    const { POST } = await import("../portal/route");

    const response = await POST(request({ flow: "cancel" }) as never);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid billing portal flow",
    });
    expect(mockRedirectToBillingPortal).not.toHaveBeenCalled();
  });

  it("returns subscription cancellation status", async () => {
    mockGetSubscriptionCancellationStatus.mockResolvedValue({
      hasActiveSubscription: true,
      cancelAtPeriodEnd: true,
      currentPeriodEnd: 1_782_444_800_000,
    } as never);
    const { GET } = await import("../subscription-status/route");

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      hasActiveSubscription: true,
      cancelAtPeriodEnd: true,
      currentPeriodEnd: 1_782_444_800_000,
    });
  });

  it("keeps a subscription through a stable POST endpoint", async () => {
    mockKeepSubscription.mockResolvedValue({
      kept: true,
      cancelAtPeriodEnd: false,
      alreadyKept: false,
    } as never);
    const { POST } = await import("../keep/route");

    const response = await POST();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      kept: true,
      cancelAtPeriodEnd: false,
      alreadyKept: false,
    });
  });

  it("passes cancellation reason input to the cancellation action", async () => {
    mockCancelSubscription.mockResolvedValue({
      canceled: true,
      cancelAtPeriodEnd: true,
      alreadyScheduled: false,
    } as never);
    const { POST } = await import("../cancel/route");

    const response = await POST(
      request({
        cancellationReason: {
          reasonCategory: "too_expensive",
          reasonDetails: "Budget changed",
        },
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(mockCancelSubscription).toHaveBeenCalledWith({
      cancellationReason: {
        reasonCategory: "too_expensive",
        reasonDetails: "Budget changed",
      },
    });
  });

  it("returns a validation error for malformed cancellation bodies", async () => {
    const { POST } = await import("../cancel/route");
    const malformedBodies = [
      null,
      {},
      { cancellationReason: null },
      { cancellationReason: [] },
    ];

    for (const body of malformedBodies) {
      const response = await POST(request(body) as never);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "Please select the main cancellation reason",
      });
    }

    const unreadableResponse = await POST(unreadableJsonRequest() as never);

    expect(unreadableResponse.status).toBe(400);
    await expect(unreadableResponse.json()).resolves.toEqual({
      error: "Please select the main cancellation reason",
    });
    expect(mockCancelSubscription).not.toHaveBeenCalled();
  });
});
