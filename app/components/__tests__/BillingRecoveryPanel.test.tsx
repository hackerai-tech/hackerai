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
jest.mock("@/lib/actions/recover-canceled-renewal", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockRecover(...args),
}));
jest.mock("@/lib/billing/client", () => ({
  openRenewalInvoice: (...args: unknown[]) => mockInvoice(...args),
  redirectToBillingPortal: (...args: unknown[]) => mockPortal(...args),
}));
jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: (...args: unknown[]) => mockCapture(...args),
}));
jest.mock("sonner", () => ({
  toast: { success: (...args: unknown[]) => mockSuccess(...args) },
}));

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
  beforeEach(() => {
    jest.resetAllMocks();
    window.history.replaceState(null, "", "/c/test");
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
