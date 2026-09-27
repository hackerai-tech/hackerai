import { render, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { BillingRecoveryReturnNotice } from "../BillingRecoveryReturnNotice";
import { getSubscriptionCancellationStatus } from "@/lib/billing/client";

jest.mock("sonner", () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warning: jest.fn(),
  },
}));
jest.mock("@/lib/billing/client", () => ({
  getSubscriptionCancellationStatus: jest.fn(),
}));

const statusMock = jest.mocked(getSubscriptionCancellationStatus);

afterEach(() => window.history.replaceState(null, "", "/"));

it("reports an unpaid retry after portal return and supports checking again", async () => {
  window.history.replaceState(
    { route: "chat" },
    "",
    "/c/test?billing-recovery-return=1&refresh=entitlements",
  );
  statusMock
    .mockResolvedValueOnce({
      hasActiveSubscription: true,
      cancelAtPeriodEnd: false,
      subscriptionStatus: "past_due",
      renewalPaymentRequired: true,
      renewalPaymentFailure: "insufficient_funds",
    })
    .mockResolvedValueOnce({
      hasActiveSubscription: true,
      cancelAtPeriodEnd: false,
      subscriptionStatus: "active",
      renewalInvoicePaid: true,
    });
  render(<BillingRecoveryReturnNotice />);
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith(
      "Your renewal invoice is still unpaid",
      expect.objectContaining({
        description: expect.stringContaining("insufficient funds"),
      }),
    ),
  );
  expect(window.location.search).toBe("?refresh=entitlements");
  expect(window.history.state).toEqual({ route: "chat" });
  const options = jest.mocked(toast.error).mock.calls[0][1] as {
    action: { onClick: () => void };
  };
  options.action.onClick();
  await waitFor(() =>
    expect(toast.success).toHaveBeenCalledWith(
      "Your renewal invoice is paid. Your plan is active.",
      { id: "billing-recovery-return" },
    ),
  );
});

it("does not claim invoice success from an active plan alone", async () => {
  window.history.replaceState(null, "", "/?billing-recovery-return=1");
  statusMock.mockResolvedValue({
    hasActiveSubscription: true,
    cancelAtPeriodEnd: false,
    subscriptionStatus: "active",
  });
  render(<BillingRecoveryReturnNotice />);
  await waitFor(() => expect(toast.info).toHaveBeenCalled());
  expect(toast.success).not.toHaveBeenCalled();
});

it("does not check billing without a portal return marker", () => {
  render(<BillingRecoveryReturnNotice />);
  expect(statusMock).not.toHaveBeenCalled();
});
