import { describe, expect, it, jest, beforeEach } from "@jest/globals";

const mockCreateBillingPortalSession = jest.fn();
const mockGetBillingActionContext = jest.fn();
const mockPostHogError = jest.fn();

jest.mock("@/app/api/stripe", () => ({
  stripe: {
    billingPortal: {
      sessions: {
        create: mockCreateBillingPortalSession,
      },
    },
  },
}));

jest.mock("@/lib/actions/billing-context", () => ({
  getBillingActionContext: mockGetBillingActionContext,
}));

jest.mock("@/lib/posthog/server", () => ({
  phLogger: {
    error: mockPostHogError,
  },
}));

describe("redirectToBillingPortal", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_BASE_URL = "https://hackerai.co";
    mockGetBillingActionContext.mockResolvedValue({
      organizationId: "org_123",
      user: { id: "user_123" },
      stripeCustomerId: "cus_123",
    } as never);
  });

  it("returns the Stripe billing portal URL", async () => {
    mockCreateBillingPortalSession.mockResolvedValue({
      url: "https://billing.stripe.com/session",
    } as never);

    const { default: redirectToBillingPortal } =
      await import("../billing-portal");

    await expect(redirectToBillingPortal()).resolves.toBe(
      "https://billing.stripe.com/session",
    );

    expect(mockCreateBillingPortalSession).toHaveBeenCalledWith({
      customer: "cus_123",
      return_url: "https://hackerai.co",
    });
    expect(mockPostHogError).not.toHaveBeenCalled();
  });

  it("logs the action stage when Stripe session creation fails", async () => {
    const error = new Error("Stripe unavailable");
    mockCreateBillingPortalSession.mockRejectedValue(error as never);

    const { default: redirectToBillingPortal } =
      await import("../billing-portal");

    await expect(redirectToBillingPortal()).rejects.toThrow(
      "Stripe unavailable",
    );

    expect(mockPostHogError).toHaveBeenCalledWith(
      "billing_portal_action_failed",
      expect.objectContaining({
        event: "billing_portal_action_failed",
        stage: "stripe_session_create",
        userId: "user_123",
        org_id: "org_123",
        stripe_customer_id: "cus_123",
        error,
      }),
    );
  });

  it("does not log expected billing context failures", async () => {
    const error = new Error("Only admins or owners can manage billing");
    mockGetBillingActionContext.mockRejectedValue(error as never);

    const { default: redirectToBillingPortal } =
      await import("../billing-portal");

    await expect(redirectToBillingPortal()).rejects.toThrow(
      "Only admins or owners can manage billing",
    );

    expect(mockCreateBillingPortalSession).not.toHaveBeenCalled();
    expect(mockPostHogError).not.toHaveBeenCalled();
  });

  it("logs unexpected billing context failures", async () => {
    const error = new Error("Failed to fetch organization details");
    mockGetBillingActionContext.mockRejectedValue(error as never);

    const { default: redirectToBillingPortal } =
      await import("../billing-portal");

    await expect(redirectToBillingPortal()).rejects.toThrow(
      "Failed to fetch organization details",
    );

    expect(mockPostHogError).toHaveBeenCalledWith(
      "billing_portal_action_failed",
      expect.objectContaining({
        event: "billing_portal_action_failed",
        stage: "billing_context",
        error,
      }),
    );
  });

  it("logs the action stage when Stripe returns no portal URL", async () => {
    mockCreateBillingPortalSession.mockResolvedValue({} as never);

    const { default: redirectToBillingPortal } =
      await import("../billing-portal");

    await expect(redirectToBillingPortal()).rejects.toThrow(
      "Failed to create billing portal session",
    );

    expect(mockPostHogError).toHaveBeenCalledWith(
      "billing_portal_action_failed",
      expect.objectContaining({
        event: "billing_portal_action_failed",
        stage: "missing_session_url",
        userId: "user_123",
        org_id: "org_123",
        stripe_customer_id: "cus_123",
        error: expect.any(Error),
      }),
    );
  });
});
