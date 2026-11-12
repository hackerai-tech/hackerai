import "@testing-library/jest-dom";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BillingRecoveryPanel } from "../BillingRecoveryPanel";
import type { SubscriptionCancellationStatus } from "@/lib/billing/api-types";

const mockInvoice = jest.fn();
const mockPortal = jest.fn();
const mockCapture = jest.fn();
const mockSuccess = jest.fn();
const mockRecover = jest.fn();
const mockPostHogCapture = jest.fn();
jest.mock("@/lib/actions/recover-canceled-renewal", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockRecover(...args),
}));
jest.mock("@/lib/billing/client", () => ({
  openRenewalInvoice: (...args: unknown[]) => mockInvoice(...args),
  redirectToBillingPortal: (...args: unknown[]) => mockPortal(...args),
}));
// Keep the real consent/identity queue; only the panel's own impressions are stubbed.
jest.mock("@/lib/analytics/client", () => ({
  ...jest.requireActual<typeof import("@/lib/analytics/client")>(
    "@/lib/analytics/client",
  ),
  captureAuthenticatedEvent: (...args: unknown[]) => mockCapture(...args),
}));
jest.mock("posthog-js", () => ({
  __esModule: true,
  default: {
    __loaded: true,
    capture: (...args: unknown[]) => mockPostHogCapture(...args),
  },
}));
jest.mock("sonner", () => ({
  toast: { success: (...args: unknown[]) => mockSuccess(...args) },
}));

const {
  confirmAuthenticatedAnalyticsUserId,
  loadPostHogClient,
  setAuthenticatedAnalyticsUserId,
} = jest.requireMock<typeof import("@/lib/analytics/client")>(
  "@/lib/analytics/client",
);
const BUILD = "0123456789".repeat(4);
const originalPostHogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const originalBuild = process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;
const reviewStatus: SubscriptionCancellationStatus = {
  hasActiveSubscription: false,
  cancelAtPeriodEnd: false,
  checkoutRequiresReview: true,
};
const missingAction = () =>
  new Error(
    `Failed to find Server Action "${"0b".repeat(21)}". This request might be from an older or newer deployment.\nRead more: https://nextjs.org/docs/messages/failed-to-find-server-action`,
  );

function identifyAnalyticsOwner(userId: string | null) {
  setAuthenticatedAnalyticsUserId(userId);
  if (userId) confirmAuthenticatedAnalyticsUserId(userId);
}

function serverActionContexts() {
  return mockPostHogCapture.mock.calls.filter(
    ([event]) => event === "server_action_client_context",
  );
}

const overdue: SubscriptionCancellationStatus = {
  hasActiveSubscription: true,
  cancelAtPeriodEnd: false,
  subscriptionStatus: "past_due",
  renewalPaymentRequired: true,
  renewalInvoicePayable: true,
  latestInvoiceId: "in_renewal",
  renewalInvoiceAmountRemaining: 2500,
  renewalInvoiceCurrency: "usd",
};

describe("BillingRecoveryPanel", () => {
  beforeAll(async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT = BUILD;
    await loadPostHogClient();
  });
  afterAll(() => {
    for (const [key, value] of [
      ["NEXT_PUBLIC_POSTHOG_KEY", originalPostHogKey],
      ["NEXT_PUBLIC_HACKERAI_BUILD_COMMIT", originalBuild],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  beforeEach(() => {
    jest.resetAllMocks();
    window.history.replaceState(null, "", "/c/test");
    window.sessionStorage.clear();
    identifyAnalyticsOwner(null);
  });
  const draw = (status = overdue, onCheck = jest.fn(async () => overdue)) =>
    render(
      <BillingRecoveryPanel
        status={status}
        subscription="free"
        surface="pricing_dialog"
        onCheck={onCheck}
      />,
    );

  it("shows the actual balance and opens a fresh invoice payment URL", async () => {
    mockInvoice.mockResolvedValue("#invoice");
    draw();
    expect(screen.getByText("$25.00")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Pay invoice" }));
    await waitFor(() => expect(window.location.hash).toBe("#invoice"));
    expect(mockInvoice).toHaveBeenCalledWith();
    expect(mockPortal).not.toHaveBeenCalled();
  });

  it("opens card update directly and returns to the same chat", async () => {
    mockPortal.mockResolvedValue("#card");
    draw();
    await userEvent.click(screen.getByRole("button", { name: "Update card" }));
    await waitFor(() =>
      expect(mockPortal).toHaveBeenCalledWith("payment_method", {
        surface: "pricing_dialog",
        returnPath: "/c/test",
      }),
    );
  });

  it("never offers old invoice payment for canceled-review status", () => {
    draw({
      hasActiveSubscription: false,
      cancelAtPeriodEnd: false,
      checkoutRequiresReview: true,
    });
    expect(
      screen.getByRole("link", { name: "Get billing help" }),
    ).toHaveAttribute(
      "href",
      expect.stringContaining("mailto:contact@hackerai.co"),
    );
    expect(
      screen.queryByRole("button", { name: "Pay invoice" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/Paying an old invoice won’t restart/),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Update card" })).toBeEnabled();
  });

  it("refreshes billing after Start fresh and lets the user choose a new plan", async () => {
    const check = jest.fn(async () => ({
      hasActiveSubscription: false,
      cancelAtPeriodEnd: false,
      checkoutRequiresReview: false,
    }));
    mockRecover.mockResolvedValue(true);
    draw(
      {
        hasActiveSubscription: false,
        cancelAtPeriodEnd: false,
        checkoutRequiresReview: true,
      },
      check,
    );
    await userEvent.click(screen.getByRole("button", { name: "Start fresh" }));
    await waitFor(() =>
      expect(mockSuccess).toHaveBeenCalledWith(
        "You can now choose a plan and subscribe again.",
      ),
    );
    expect(check).toHaveBeenCalledTimes(1);
    expect(mockInvoice).not.toHaveBeenCalled();
    expect(mockPortal).not.toHaveBeenCalled();
  });

  it("keeps an unresolved or failed recovery blocked without a success message", async () => {
    const check = jest.fn(async () => ({
      hasActiveSubscription: false,
      cancelAtPeriodEnd: false,
      checkoutRequiresReview: true,
    }));
    mockRecover.mockResolvedValue(false);
    draw(
      {
        hasActiveSubscription: false,
        cancelAtPeriodEnd: false,
        checkoutRequiresReview: true,
      },
      check,
    );
    await userEvent.click(screen.getByRole("button", { name: "Start fresh" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "still needs billing review",
    );
    expect(mockSuccess).not.toHaveBeenCalled();
    mockRecover.mockRejectedValue(new Error("Stripe unavailable"));
    await userEvent.click(screen.getByRole("button", { name: "Start fresh" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "couldn't prepare your new subscription",
    );
    expect(screen.getByRole("button", { name: "Start fresh" })).toBeEnabled();
  });

  it("keeps the Start fresh failure for an unavailable action and records its local context", async () => {
    identifyAnalyticsOwner("user-a");
    const check = jest.fn(async () => reviewStatus);
    mockRecover.mockRejectedValue(missingAction());
    draw(reviewStatus, check);

    await userEvent.click(screen.getByRole("button", { name: "Start fresh" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "We couldn't prepare your new subscription. Check payment status or try again.",
    );
    expect(screen.getByRole("button", { name: "Start fresh" })).toBeEnabled();
    expect(mockRecover).toHaveBeenCalledTimes(1);
    expect(mockRecover).toHaveBeenCalledWith();
    expect(check).not.toHaveBeenCalled();
    expect(mockSuccess).not.toHaveBeenCalled();
    expect(serverActionContexts()).toEqual([
      [
        "server_action_client_context",
        {
          server_action_client_diagnostic_version: 1,
          caller: "billing_renewal_recovery",
          matched_pattern: "server_action_missing_message",
          reference_shape: "hex42",
          recovery_decision: "locally_handled_no_reload",
          build_state: "measured",
          hackerai_frontend_build_commit: BUILD,
          attempt_denominator_kind: "caller_settled_prefix",
          caller_settled_attempt_count: 1,
          caller_recognized_rejection_count: 1,
        },
        { uuid: expect.any(String) },
      ],
    ]);
    expect(
      window.sessionStorage.getItem("hackerai:chunk-load-reload-at"),
    ).toBeNull();
  });

  it("does not attribute a later status-check failure to the recovery action", async () => {
    identifyAnalyticsOwner("user-a");
    // Even a matching message from the status check is outside the action phase.
    const check = jest
      .fn<Promise<SubscriptionCancellationStatus | undefined>, []>()
      .mockRejectedValueOnce(missingAction());
    mockRecover.mockResolvedValueOnce(true);
    draw(reviewStatus, check);

    await userEvent.click(screen.getByRole("button", { name: "Start fresh" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "couldn't prepare your new subscription",
    );
    expect(check).toHaveBeenCalledTimes(1);
    expect(serverActionContexts()).toEqual([]);

    mockRecover.mockRejectedValueOnce(missingAction());
    await userEvent.click(screen.getByRole("button", { name: "Start fresh" }));
    await waitFor(() => expect(serverActionContexts()).toHaveLength(1));
    expect(serverActionContexts()[0][1]).toMatchObject({
      caller: "billing_renewal_recovery",
      caller_settled_attempt_count: 2,
      caller_recognized_rejection_count: 1,
    });
    expect(mockRecover).toHaveBeenCalledTimes(2);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("drops a pending recovery failure after the analytics owner changes", async () => {
    identifyAnalyticsOwner("user-a");
    let rejectRecover: (error: Error) => void = () => {};
    mockRecover.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectRecover = reject;
      }),
    );
    draw(reviewStatus);

    await userEvent.click(screen.getByRole("button", { name: "Start fresh" }));
    identifyAnalyticsOwner("user-b");
    await act(async () => rejectRecover(missingAction()));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "couldn't prepare your new subscription",
    );
    expect(serverActionContexts()).toEqual([]);
  });

  it("offers bank authentication through the invoice", () => {
    draw({ ...overdue, renewalPaymentFailure: "authentication_required" });
    expect(
      screen.getByRole("button", { name: "Complete payment" }),
    ).toBeEnabled();
  });

  it("keeps review actions available without claiming a failed payment when history is unavailable", () => {
    draw({
      hasActiveSubscription: false,
      cancelAtPeriodEnd: false,
      checkoutRequiresReview: true,
      billingReviewUnavailable: true,
    });
    expect(
      screen.getByText("We couldn’t verify your billing status"),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Update card" })).toBeEnabled();
    expect(
      screen.getByRole("link", { name: "Get billing help" }),
    ).toBeVisible();
    expect(screen.queryByText(/An unresolved payment/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Pay invoice" }),
    ).not.toBeInTheDocument();
  });

  it("does not offer invoice payment without server eligibility", () => {
    draw({ ...overdue, renewalInvoicePayable: false });
    expect(
      screen.queryByRole("button", { name: "Pay invoice" }),
    ).not.toBeInTheDocument();
  });

  it("keeps a failed request visible and allows another attempt", async () => {
    mockInvoice.mockRejectedValue(
      new Error("Invoice state changed. Check billing."),
    );
    draw();
    await userEvent.click(screen.getByRole("button", { name: "Pay invoice" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Invoice state changed",
    );
    expect(screen.getByRole("button", { name: "Pay invoice" })).toBeEnabled();
    expect(mockSuccess).not.toHaveBeenCalled();
  });

  it("does not claim recovery after a card update or unpaid status check", async () => {
    const check = jest.fn(async () => overdue);
    draw(overdue, check);
    await userEvent.click(
      screen.getByRole("button", { name: "Check payment status" }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Payment is not confirmed yet",
    );
    expect(mockSuccess).not.toHaveBeenCalled();
  });

  it("only offers access refresh after a paid renewal and eligible subscription", async () => {
    const check = jest.fn(async () => ({
      ...overdue,
      renewalInvoicePaid: true,
      subscriptionStatus: "active" as const,
      renewalPaymentRequired: false,
    }));
    draw(overdue, check);
    await userEvent.click(
      screen.getByRole("button", { name: "Check payment status" }),
    );
    await waitFor(() =>
      expect(mockSuccess).toHaveBeenCalledWith(
        "Your renewal invoice is paid. Refresh to update your access.",
        expect.objectContaining({
          action: expect.objectContaining({ label: "Refresh" }),
        }),
      ),
    );
  });

  it("disables other actions while a payment page is opening", async () => {
    let reject: (error: Error) => void = () => {};
    mockInvoice.mockReturnValue(
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
    );
    draw();
    await userEvent.click(screen.getByRole("button", { name: "Pay invoice" }));
    expect(screen.getByRole("button", { name: "Update card" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Check payment status" }),
    ).toBeDisabled();
    await act(async () => reject(new Error("Canceled")));
  });
});
