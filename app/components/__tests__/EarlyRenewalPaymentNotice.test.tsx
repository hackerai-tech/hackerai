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
  role?: string;
  loading: boolean;
  entitlements?: string[];
} = { user: { id: "user_a" }, organizationId: "org_a", loading: false };
jest.mock("@workos-inc/authkit-nextjs/components", () => ({
  useAuth: () => mockAuth,
}));
let mockSubscription = "pro";
let mockPlanResolved = true;
jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({
    subscription: mockSubscription,
    chatModeAccessResolved: mockPlanResolved,
  }),
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
// Every HTTP request fails, as when feature-flag services are unreachable.
const unavailableFetch = jest.fn(async () => {
  throw new TypeError("Failed to fetch");
});

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
  global.fetch = unavailableFetch as unknown as typeof fetch;
});
afterAll(() => {
  global.fetch = originalFetch;
  if (originalPostHogKey === undefined)
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
  else process.env.NEXT_PUBLIC_POSTHOG_KEY = originalPostHogKey;
});
beforeEach(() => {
  unavailableFetch.mockClear();
  mockSubscription = "pro";
  mockPlanResolved = true;
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

it("shows the notice without any feature-flag request while flag services are down", async () => {
  // A past-due subscriber's entitlement can already have dropped to free.
  mockSubscription = "free";
  setup();
  expect(
    await screen.findByTestId("renewal-payment-notice"),
  ).toBeInTheDocument();
  expect(unavailableFetch).not.toHaveBeenCalled();
});

it("starts the billing lookup once the personal plan finishes resolving", async () => {
  mockPlanResolved = false;
  const view = setup();
  expect(statusMock).not.toHaveBeenCalled();

  mockPlanResolved = true;
  view.rerender(
    <SWRConfig value={{ provider: () => new Map() }}>{notice({})}</SWRConfig>,
  );
  expect(await screen.findByTestId("renewal-payment-notice")).toBeVisible();
  expect(statusMock).toHaveBeenCalledTimes(1);
  expect(unavailableFetch).not.toHaveBeenCalled();
});

it.each<[string, () => void]>([
  ["team members", () => (mockSubscription = "team")],
  [
    "team members with a member role",
    () => {
      mockSubscription = "team";
      mockAuth = { ...mockAuth, role: "member" };
    },
  ],
  [
    "a team admin without a current organization",
    () => {
      mockSubscription = "team";
      mockAuth = { ...mockAuth, organizationId: undefined, role: "admin" };
    },
  ],
  [
    // Access is resolved, but the team token has not reached `subscription`.
    "a team token before the plan state catches up",
    () => {
      mockSubscription = "free";
      mockAuth = { ...mockAuth, entitlements: ["team-plan"] };
    },
  ],
  [
    // The placeholder plan is free until entitlements reveal, e.g., a team.
    "a plan that is still resolving",
    () => {
      mockSubscription = "free";
      mockPlanResolved = false;
    },
  ],
  [
    "signed-out visitors",
    () =>
      (mockAuth = { user: null, organizationId: undefined, loading: false }),
  ],
  [
    "a session that is still loading",
    () => (mockAuth = { user: { id: "user_a" }, loading: true }),
  ],
])("makes no billing request for %s", async (_, arrange) => {
  arrange();
  setup();
  await act(async () => {});
  expect(statusMock).not.toHaveBeenCalled();
  expect(
    screen.queryByTestId("renewal-payment-notice"),
  ).not.toBeInTheDocument();
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
])("does not claim an overdue renewal for a %s status", async (_, status) => {
  statusMock.mockResolvedValue(status);
  setup();
  await waitFor(() => expect(statusMock).toHaveBeenCalledTimes(1));
  await act(async () => {});
  expect(
    screen.queryByTestId("renewal-payment-notice"),
  ).not.toBeInTheDocument();
});

it.each(["admin", "owner"])(
  "shows a Team %s the renewal named from the live Stripe plan",
  async (role) => {
    mockSubscription = "team";
    mockAuth = { ...mockAuth, role };
    statusMock.mockResolvedValue({
      ...failedRenewal,
      stripePriceLookupKey: "team-monthly-plan",
    });
    setup();
    expect(
      await screen.findByText("Your Team renewal payment failed."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Update payment" }),
    ).toBeEnabled();
  },
);

it("shows a Team admin nothing when the server rejects the billing membership", async () => {
  // A session role can be stale; the status lookup re-checks membership.
  mockSubscription = "team";
  mockAuth = { ...mockAuth, role: "admin" };
  statusMock.mockRejectedValue(
    new Error("Only admins or owners can manage billing"),
  );
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

it("hides immediately even when session storage rejects writes", async () => {
  const setItem = jest
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("SecurityError");
    });
  try {
    setup();
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Hide renewal payment notice",
      }),
    );
    expect(setItem).toHaveBeenCalled();
    expect(
      screen.queryByTestId("renewal-payment-notice"),
    ).not.toBeInTheDocument();
  } finally {
    setItem.mockRestore();
  }
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
