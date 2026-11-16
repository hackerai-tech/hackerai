import { act, render, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { toast } from "sonner";
import { BillingRecoveryReturnNotice } from "../BillingRecoveryReturnNotice";
import { getSubscriptionCancellationStatus } from "@/lib/billing/client";
import { reloadWithEntitlementRefresh } from "@/lib/auth/entitlement-refresh-navigation";
import { captureQueuedAuthenticatedEvent } from "@/lib/analytics/client";

let mockAuth: {
  user: { id: string } | null;
  organizationId?: string;
  loading: boolean;
} = { user: { id: "user_a" }, organizationId: "org_a", loading: false };
jest.mock("@workos-inc/authkit-nextjs/components", () => ({
  useAuth: () => mockAuth,
}));
jest.mock("@/lib/analytics/client", () => ({
  captureQueuedAuthenticatedEvent: jest.fn(),
  getPermittedAnalyticsUserId: () => mockAuth.user?.id ?? null,
}));
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
jest.mock("@/lib/auth/entitlement-refresh-navigation", () => ({
  reloadWithEntitlementRefresh: jest.fn(),
}));

const statusMock = jest.mocked(getSubscriptionCancellationStatus);
const traceMock = jest.mocked(captureQueuedAuthenticatedEvent);
const returnedStates = () =>
  traceMock.mock.calls.map(([call]) => call.properties?.payment_state);

beforeEach(() => {
  mockAuth = {
    user: { id: "user_a" },
    organizationId: "org_a",
    loading: false,
  };
});
afterEach(() => window.history.replaceState(null, "", "/"));

it("reports unavailable billing history without claiming an unresolved payment", async () => {
  window.history.replaceState(null, "", "/?billing-recovery-return=1");
  statusMock.mockResolvedValue({
    hasActiveSubscription: false,
    cancelAtPeriodEnd: false,
    checkoutRequiresReview: true,
    billingReviewUnavailable: true,
  });
  render(<BillingRecoveryReturnNotice />);
  await waitFor(() =>
    expect(toast.warning).toHaveBeenCalledWith(
      "We couldn't verify your billing status",
      expect.objectContaining({
        action: expect.objectContaining({ label: "Review billing" }),
      }),
    ),
  );
  expect(toast.success).not.toHaveBeenCalled();
});

it("keeps canceled-renewal review separate from successful card management", async () => {
  window.history.replaceState(null, "", "/?billing-recovery-return=1");
  statusMock.mockResolvedValue({
    hasActiveSubscription: false,
    cancelAtPeriodEnd: false,
    billingAccountAvailable: true,
    checkoutRequiresReview: true,
  });
  render(<BillingRecoveryReturnNotice />);
  await waitFor(() =>
    expect(toast.warning).toHaveBeenCalledWith(
      "Your previous subscription payment still needs review",
      expect.objectContaining({
        action: expect.objectContaining({ label: "Review billing" }),
      }),
    ),
  );
  expect(toast.success).not.toHaveBeenCalled();
  expect(toast.error).not.toHaveBeenCalled();
});

it("does not claim payment restored access for a canceled subscription", async () => {
  window.history.replaceState(null, "", "/?billing-recovery-return=1");
  statusMock.mockResolvedValue({
    hasActiveSubscription: false,
    cancelAtPeriodEnd: false,
    billingAccountAvailable: true,
    checkoutRequiresReview: false,
  });
  render(<BillingRecoveryReturnNotice />);
  await waitFor(() =>
    expect(toast.info).toHaveBeenCalledWith(
      "You can choose a plan to subscribe again",
      expect.anything(),
    ),
  );
  expect(toast.success).not.toHaveBeenCalled();
});

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
        action: expect.objectContaining({ label: "Resolve payment" }),
      }),
    ),
  );
  expect(window.location.search).toBe("?refresh=entitlements");
  expect(window.history.state).toEqual({ route: "chat" });
  expect(reloadWithEntitlementRefresh).not.toHaveBeenCalled();
  // Returning from the portal is traced as unpaid, never as a payment.
  expect(toast.success).not.toHaveBeenCalled();
  expect(returnedStates()).toEqual(["unpaid"]);
  // The initial entitlement refresh can finish before Stripe's payment webhook.
  window.history.replaceState({ route: "chat" }, "", "/c/test");
  const options = jest.mocked(toast.error).mock.calls[0][1] as {
    cancel: { onClick: () => void };
  };
  options.cancel.onClick();
  await waitFor(() =>
    expect(toast.success).toHaveBeenCalledWith(
      "Your renewal invoice is paid. Refresh to update your access.",
      expect.objectContaining({
        id: "billing-recovery-return",
        action: { label: "Refresh", onClick: expect.any(Function) },
      }),
    ),
  );
  expect(reloadWithEntitlementRefresh).not.toHaveBeenCalled();
  const paidOptions = jest.mocked(toast.success).mock.calls[0][1] as {
    action: { onClick: () => void };
  };
  paidOptions.action.onClick();
  expect(reloadWithEntitlementRefresh).toHaveBeenCalledTimes(1);
  expect(returnedStates()).toEqual(["unpaid", "paid"]);
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
  expect(jest.mocked(toast.info).mock.calls[0][1]).toMatchObject({
    action: { label: "Check again" },
  });
});

it("ignores an older unpaid result after a newer recheck confirms payment", async () => {
  window.history.replaceState(null, "", "/?billing-recovery-return=1");
  let resolveOlder!: (
    status: Awaited<ReturnType<typeof getSubscriptionCancellationStatus>>,
  ) => void;
  let resolveNewer!: (
    status: Awaited<ReturnType<typeof getSubscriptionCancellationStatus>>,
  ) => void;
  const older = new Promise<
    Awaited<ReturnType<typeof getSubscriptionCancellationStatus>>
  >((resolve) => {
    resolveOlder = resolve;
  });
  const newer = new Promise<
    Awaited<ReturnType<typeof getSubscriptionCancellationStatus>>
  >((resolve) => {
    resolveNewer = resolve;
  });
  statusMock
    .mockResolvedValueOnce({
      hasActiveSubscription: true,
      cancelAtPeriodEnd: false,
      subscriptionStatus: "active",
    })
    .mockImplementationOnce(() => older)
    .mockImplementationOnce(() => newer);
  render(<BillingRecoveryReturnNotice />);
  await waitFor(() => expect(toast.info).toHaveBeenCalled());
  const options = jest.mocked(toast.info).mock.calls[0][1] as {
    action: { onClick: () => void };
  };
  options.action.onClick();
  options.action.onClick();
  await act(async () => {
    resolveNewer({
      hasActiveSubscription: true,
      cancelAtPeriodEnd: false,
      subscriptionStatus: "active",
      renewalInvoicePaid: true,
    });
  });
  expect(toast.success).toHaveBeenCalledTimes(1);
  await act(async () => {
    resolveOlder({
      hasActiveSubscription: true,
      cancelAtPeriodEnd: false,
      subscriptionStatus: "past_due",
      renewalPaymentRequired: true,
    });
  });
  expect(toast.error).not.toHaveBeenCalled();
});

it("does not check billing without a portal return marker", () => {
  render(<BillingRecoveryReturnNotice />);
  expect(statusMock).not.toHaveBeenCalled();
});

it("waits for the signed-in identity before checking a portal return", async () => {
  window.history.replaceState(null, "", "/?billing-recovery-return=1");
  mockAuth = { user: null, loading: true };
  statusMock.mockResolvedValue({
    hasActiveSubscription: true,
    cancelAtPeriodEnd: false,
    subscriptionStatus: "past_due",
    renewalPaymentRequired: true,
  });
  const view = render(<BillingRecoveryReturnNotice />);
  // The marker is consumed immediately so a reload cannot repeat the check.
  expect(window.location.search).toBe("");
  expect(statusMock).not.toHaveBeenCalled();
  mockAuth = {
    user: { id: "user_a" },
    organizationId: "org_a",
    loading: false,
  };
  view.rerender(<BillingRecoveryReturnNotice />);
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith(
      "Your renewal invoice is still unpaid",
      expect.anything(),
    ),
  );
  expect(statusMock).toHaveBeenCalledTimes(1);
});

it("drops a late result after switching accounts and never reports it to the new one", async () => {
  window.history.replaceState(null, "", "/?billing-recovery-return=1");
  let resolveStatus!: (
    status: Awaited<ReturnType<typeof getSubscriptionCancellationStatus>>,
  ) => void;
  statusMock.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveStatus = resolve;
      }),
  );
  const view = render(<BillingRecoveryReturnNotice />);
  await waitFor(() => expect(statusMock).toHaveBeenCalledTimes(1));
  mockAuth = {
    user: { id: "user_b" },
    organizationId: "org_b",
    loading: false,
  };
  view.rerender(<BillingRecoveryReturnNotice />);
  await act(async () => {
    resolveStatus({
      hasActiveSubscription: true,
      cancelAtPeriodEnd: false,
      subscriptionStatus: "active",
      renewalInvoicePaid: true,
    });
  });
  expect(toast.success).not.toHaveBeenCalled();
  expect(toast.error).not.toHaveBeenCalled();
  expect(traceMock).not.toHaveBeenCalled();
  // The other account did not return from billing, so it is not checked.
  expect(statusMock).toHaveBeenCalledTimes(1);
});

it("still shows the return notice under React Strict Mode", async () => {
  window.history.replaceState(null, "", "/?billing-recovery-return=1");
  statusMock.mockResolvedValue({
    hasActiveSubscription: true,
    cancelAtPeriodEnd: false,
    subscriptionStatus: "active",
  });
  render(
    <StrictMode>
      <BillingRecoveryReturnNotice />
    </StrictMode>,
  );
  await waitFor(() => expect(toast.info).toHaveBeenCalledTimes(1));
});
