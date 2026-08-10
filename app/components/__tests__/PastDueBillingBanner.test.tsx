import "@testing-library/jest-dom";
import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockGetSubscriptionCancellationStatus = jest.fn();
const mockRedirectToBillingPortal = jest.fn();
const mockCaptureAuthenticatedEvent = jest.fn();
const mockToastError = jest.fn();
let mockSubscription = "pro";

jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({ subscription: mockSubscription }),
}));

jest.mock("@/lib/billing/client", () => ({
  getSubscriptionCancellationStatus: mockGetSubscriptionCancellationStatus,
  redirectToBillingPortal: mockRedirectToBillingPortal,
}));

jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: mockCaptureAuthenticatedEvent,
}));

jest.mock("sonner", () => ({
  toast: { error: mockToastError },
}));

const { PastDueBillingNotice } =
  require("../PastDueBillingBanner") as typeof import("../PastDueBillingBanner");

describe("PastDueBillingNotice", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSubscription = "pro";
    window.history.replaceState(null, "", "/");
  });

  it("shows a global warning and opens payment method update", async () => {
    mockGetSubscriptionCancellationStatus.mockResolvedValue({
      hasActiveSubscription: true,
      cancelAtPeriodEnd: false,
      subscriptionStatus: "past_due",
    } as never);
    mockRedirectToBillingPortal.mockResolvedValue("#payment-method" as never);

    render(<PastDueBillingNotice />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Your renewal payment failed—update your payment method to keep your plan.",
    );
    expect(mockCaptureAuthenticatedEvent).toHaveBeenCalledWith(
      "billing_past_due_banner_impressed",
      expect.objectContaining({
        surface: "chat_layout",
        subscription_tier: "pro",
        subscription_status: "past_due",
      }),
    );

    const user = userEvent.setup();
    await user.click(
      within(alert).getByRole("button", { name: "Update payment" }),
    );

    await waitFor(() => {
      expect(mockRedirectToBillingPortal).toHaveBeenCalledWith(
        "payment_method",
      );
    });
    expect(mockCaptureAuthenticatedEvent).toHaveBeenCalledWith(
      "billing_past_due_payment_update_clicked",
      expect.objectContaining({ surface: "chat_layout" }),
    );
    expect(window.location.hash).toBe("#payment-method");
  });

  it("does not request billing status for free users", () => {
    mockSubscription = "free";

    render(<PastDueBillingNotice />);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(mockGetSubscriptionCancellationStatus).not.toHaveBeenCalled();
  });

  it("does not expose payment updates when billing access is denied", async () => {
    mockSubscription = "team";
    mockGetSubscriptionCancellationStatus.mockRejectedValue(
      new Error("Only admins or owners can manage billing") as never,
    );

    render(<PastDueBillingNotice />);

    await waitFor(() => {
      expect(mockGetSubscriptionCancellationStatus).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(mockRedirectToBillingPortal).not.toHaveBeenCalled();
  });

  it("does not reuse stale past-due status after a plan transition", async () => {
    mockGetSubscriptionCancellationStatus.mockResolvedValueOnce({
      hasActiveSubscription: true,
      cancelAtPeriodEnd: false,
      subscriptionStatus: "past_due",
    } as never);

    const { rerender } = render(<PastDueBillingNotice />);
    expect(await screen.findByRole("alert")).toBeVisible();

    mockSubscription = "free";
    rerender(<PastDueBillingNotice />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    let resolveStatus: (value: unknown) => void = () => {};
    mockGetSubscriptionCancellationStatus.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStatus = resolve;
      }) as never,
    );
    mockSubscription = "pro";
    rerender(<PastDueBillingNotice />);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await act(async () => {
      resolveStatus({
        hasActiveSubscription: true,
        cancelAtPeriodEnd: false,
        subscriptionStatus: "active",
      });
    });
    await waitFor(() => {
      expect(mockGetSubscriptionCancellationStatus).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
