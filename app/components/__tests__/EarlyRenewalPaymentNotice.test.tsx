import "@testing-library/jest-dom";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig } from "swr";
import { EarlyRenewalPaymentNotice } from "../EarlyRenewalPaymentNotice";
import { BlockedChatBillingRecovery } from "../BlockedChatBillingRecovery";
import {
  getSubscriptionCancellationStatus,
  redirectToBillingPortal,
} from "@/lib/billing/client";
import {
  confirmAuthenticatedAnalyticsUserId,
  setAuthenticatedAnalyticsUserId,
} from "@/lib/analytics/client";
import type { SubscriptionCancellationStatus } from "@/lib/billing/api-types";

const mockPostHog = { __loaded: false, capture: jest.fn() };
jest.mock("posthog-js", () => ({ __esModule: true, default: mockPostHog }));
let mockAuth: {
  user: { id: string } | null;
  organizationId?: string;
  loading: boolean;
} = { user: { id: "user_a" }, organizationId: "org_a", loading: false };
jest.mock("@workos-inc/authkit-nextjs/components", () => ({
  useAuth: () => mockAuth,
}));
let mockSubscription = "pro";
jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({ subscription: mockSubscription }),
}));
jest.mock("@/lib/billing/client", () => ({
  ...jest.requireActual("@/lib/billing/client"),
  getSubscriptionCancellationStatus: jest.fn(),
  redirectToBillingPortal: jest.fn(),
  openRenewalInvoice: jest.fn(),
}));
jest.mock("@/lib/utils/settings-dialog", () => ({
  openSettingsDialog: jest.fn(),
}));
jest.mock("sonner", () => ({ toast: { success: jest.fn() } }));

const statusMock = jest.mocked(getSubscriptionCancellationStatus);
const portalMock = jest.mocked(redirectToBillingPortal);
const originalFetch = global.fetch;
const originalPostHogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
let flagEnabled = true;
const flagFetch = jest.fn(async () => ({
  ok: true,
  json: async () => ({ enabled: flagEnabled }),
}));

// Synthetic personal Pro subscriber whose automatic renewal failed.
const failedRenewal: SubscriptionCancellationStatus = {
  hasActiveSubscription: true,
  cancelAtPeriodEnd: false,
  subscriptionStatus: "past_due",
  renewalPaymentRequired: true,
  renewalInvoicePayable: true,
  latestInvoiceId: "in_synthetic",
  stripePriceLookupKey: "pro-monthly-plan",
  renewalInvoiceAmountRemaining: 2500,
  renewalInvoiceCurrency: "usd",
};

const notice = (props: { actionDisabled?: boolean; suppressed?: boolean }) => (
  <EarlyRenewalPaymentNotice
    actionDisabled={props.actionDisabled ?? false}
    suppressed={props.suppressed ?? false}
  />
);
function setup(ui = notice({})) {
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>{ui}</SWRConfig>,
  );
}
const impressions = () =>
  mockPostHog.capture.mock.calls.filter(
    ([event]) => event === "recovery_prompt_impressed",
  );

beforeAll(() => {
  process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
  global.fetch = flagFetch as unknown as typeof fetch;
});
afterAll(() => {
  global.fetch = originalFetch;
  if (originalPostHogKey === undefined)
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
  else process.env.NEXT_PUBLIC_POSTHOG_KEY = originalPostHogKey;
});
beforeEach(() => {
  flagEnabled = true;
  mockSubscription = "pro";
  mockAuth = {
    user: { id: "user_a" },
    organizationId: "org_a",
    loading: false,
  };
  mockPostHog.__loaded = true;
  setAuthenticatedAnalyticsUserId(null);
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/c/chat-1");
  statusMock.mockResolvedValue(failedRenewal);
});

it("shows a compact Update payment notice while the subscriber can keep chatting", async () => {
  portalMock.mockResolvedValue("#portal");
  const send = jest.fn();
  setup(
    <>
      {notice({})}
      <button onClick={send}>Send</button>
    </>,
  );
  expect(
    await screen.findByText("Your Pro renewal payment failed."),
  ).toBeInTheDocument();
  // The notice is not modal and never takes over the composer.
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(send).toHaveBeenCalledTimes(1);
  expect(portalMock).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole("button", { name: "Update payment" }));
  await waitFor(() =>
    expect(portalMock).toHaveBeenCalledWith("payment_method", {
      surface: "chat_notice",
      returnPath: "/c/chat-1",
    }),
  );
});

it("makes no billing status request when the flag is off", async () => {
  flagEnabled = false;
  setup();
  await waitFor(() => expect(flagFetch).toHaveBeenCalledTimes(1));
  await act(async () => {});
  expect(statusMock).not.toHaveBeenCalled();
  expect(
    screen.queryByTestId("renewal-payment-notice"),
  ).not.toBeInTheDocument();
});

it("does not evaluate the flag or billing for team accounts", async () => {
  mockSubscription = "team";
  setup();
  await act(async () => {});
  expect(flagFetch).not.toHaveBeenCalled();
  expect(statusMock).not.toHaveBeenCalled();
});

it.each<[string, SubscriptionCancellationStatus]>([
  [
    "paid",
    {
      ...failedRenewal,
      subscriptionStatus: "active",
      renewalPaymentRequired: undefined,
      renewalInvoicePaid: true,
    },
  ],
  ["scheduled cancel", { ...failedRenewal, cancelAtPeriodEnd: true }],
  [
    "canceled",
    {
      hasActiveSubscription: false,
      cancelAtPeriodEnd: false,
      checkoutRequiresReview: true,
    },
  ],
  [
    "team plan",
    { ...failedRenewal, stripePriceLookupKey: "team-monthly-plan" },
  ],
])("does not claim an overdue renewal for a %s status", async (_, status) => {
  statusMock.mockResolvedValue(status);
  setup();
  await waitFor(() => expect(statusMock).toHaveBeenCalledTimes(1));
  await act(async () => {});
  expect(
    screen.queryByTestId("renewal-payment-notice"),
  ).not.toBeInTheDocument();
});

it("shows nothing when the billing status is unknown", async () => {
  statusMock.mockRejectedValue(new Error("Billing unavailable"));
  setup();
  await waitFor(() => expect(statusMock).toHaveBeenCalledTimes(1));
  await act(async () => {});
  expect(
    screen.queryByTestId("renewal-payment-notice"),
  ).not.toBeInTheDocument();
});

it("disables only the billing action while a response is in flight", async () => {
  setup(notice({ actionDisabled: true }));
  expect(
    await screen.findByRole("button", { name: "Update payment" }),
  ).toBeDisabled();
});

it("yields to blocked-chat recovery and shares its one status lookup", async () => {
  setup(
    <>
      {notice({ suppressed: true })}
      <BlockedChatBillingRecovery>
        <button>Add credits</button>
      </BlockedChatBillingRecovery>
    </>,
  );
  expect(
    await screen.findByRole("button", { name: "Update card" }),
  ).toBeVisible();
  expect(
    screen.queryByTestId("renewal-payment-notice"),
  ).not.toBeInTheDocument();
  expect(statusMock).toHaveBeenCalledTimes(1);
  // Returning to the tab within the interval does not poll Stripe again.
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  await act(async () => {});
  expect(statusMock).toHaveBeenCalledTimes(1);
});

it("never shows the previous account's notice after switching accounts", async () => {
  const view = setup();
  await screen.findByTestId("renewal-payment-notice");
  statusMock.mockReturnValue(new Promise(() => {}));
  mockAuth = {
    user: { id: "user_a" },
    organizationId: "org_b",
    loading: false,
  };
  view.rerender(
    <SWRConfig value={{ provider: () => new Map() }}>{notice({})}</SWRConfig>,
  );
  expect(
    screen.queryByTestId("renewal-payment-notice"),
  ).not.toBeInTheDocument();
});

it("stays hidden for the tab session after the user hides it", async () => {
  const view = setup();
  await userEvent.click(
    await screen.findByRole("button", { name: "Hide renewal payment notice" }),
  );
  expect(
    screen.queryByTestId("renewal-payment-notice"),
  ).not.toBeInTheDocument();
  view.unmount();
  setup();
  await waitFor(() => expect(statusMock).toHaveBeenCalledTimes(2));
  await act(async () => {});
  expect(
    screen.queryByTestId("renewal-payment-notice"),
  ).not.toBeInTheDocument();
});

it("records one exposure once analytics is ready, even if it rendered first", async () => {
  mockPostHog.__loaded = false;
  setAuthenticatedAnalyticsUserId("user_a");
  const view = setup();
  await screen.findByTestId("renewal-payment-notice");
  // Remounting before the SDK is ready must not queue a second exposure.
  view.unmount();
  setup();
  await screen.findByTestId("renewal-payment-notice");
  expect(impressions()).toHaveLength(0);

  mockPostHog.__loaded = true;
  act(() => {
    confirmAuthenticatedAnalyticsUserId("user_a");
  });
  expect(impressions()).toEqual([
    [
      "recovery_prompt_impressed",
      expect.objectContaining({
        surface: "chat_notice",
        recovery_state: "renewal",
        stripe_invoice_id: "in_synthetic",
      }),
      { uuid: expect.any(String) },
    ],
  ]);
});
