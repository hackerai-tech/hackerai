import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { BlockedChatBillingRecovery } from "../BlockedChatBillingRecovery";
import {
  BillingRequestError,
  getSubscriptionCancellationStatus,
  redirectToBillingPortal,
} from "@/lib/billing/client";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import type { SubscriptionCancellationStatus } from "@/lib/billing/api-types";

let mockAuth = {
  user: { id: "user_test" },
  organizationId: "org_test",
  loading: false,
};
jest.mock("@workos-inc/authkit-nextjs/components", () => ({
  useAuth: () => mockAuth,
}));
jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({ subscription: "free" }),
}));
jest.mock("@/lib/billing/client", () => ({
  ...jest.requireActual("@/lib/billing/client"),
  getSubscriptionCancellationStatus: jest.fn(),
  redirectToBillingPortal: jest.fn(),
}));
jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: jest.fn(),
}));
jest.mock("@/lib/utils/settings-dialog", () => ({
  openSettingsDialog: jest.fn(),
}));
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }));
const statusMock = jest.mocked(getSubscriptionCancellationStatus);
const portalMock = jest.mocked(redirectToBillingPortal);
const delinquent: SubscriptionCancellationStatus = {
  hasActiveSubscription: true,
  cancelAtPeriodEnd: false,
  subscriptionStatus: "past_due",
  latestInvoiceId: "in_sandbox",
  renewalPaymentRequired: true,
};
function setup(count = 1) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      {Array.from({ length: count }, (_, i) => (
        <BlockedChatBillingRecovery key={i}>
          <button>Add credits or upgrade</button>
        </BlockedChatBillingRecovery>
      ))}
    </SWRConfig>,
  );
}
beforeEach(() => {
  jest.clearAllMocks();
  mockAuth = {
    user: { id: "user_test" },
    organizationId: "org_test",
    loading: false,
  };
  statusMock.mockResolvedValue(delinquent);
});
it.each(["past_due", "unpaid"] as const)(
  "shows renewal recovery for %s even after the tier drops to free",
  async (subscriptionStatus) => {
    statusMock.mockResolvedValue({ ...delinquent, subscriptionStatus });
    setup();
    expect(
      screen.queryByText("Add credits or upgrade"),
    ).not.toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "Update payment" }),
    ).toBeEnabled();
    expect(
      screen.getByText(/Access returns only after payment succeeds/),
    ).toBeVisible();
    expect(
      screen.queryByText("Add credits or upgrade"),
    ).not.toBeInTheDocument();
    expect(captureAuthenticatedEvent).toHaveBeenCalledWith(
      "recovery_prompt_impressed",
      expect.objectContaining({
        surface: "blocked_chat",
        subscription_status: subscriptionStatus,
      }),
    );
  },
);
it("opens the existing portal at the current chat and never resumes on selection", async () => {
  portalMock.mockRejectedValue(new Error("Portal unavailable"));
  setup();
  fireEvent.click(
    await screen.findByRole("button", { name: "Update payment" }),
  );
  await waitFor(() =>
    expect(portalMock).toHaveBeenCalledWith("payment_method", {
      surface: "blocked_chat",
      returnPath: "/",
    }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Update payment" }),
    ).toBeEnabled(),
  );
  expect(screen.queryByText("Add credits or upgrade")).not.toBeInTheDocument();
});
it("shares one status lookup across saved stops", async () => {
  setup(3);
  expect(
    await screen.findAllByRole("button", { name: "Update payment" }),
  ).toHaveLength(3);
  expect(statusMock).toHaveBeenCalledTimes(1);
});
it("offers ordinary usage actions only after a successful non-delinquent lookup", async () => {
  statusMock.mockResolvedValue({
    ...delinquent,
    subscriptionStatus: "active",
    renewalPaymentRequired: undefined,
  });
  setup();
  expect(await screen.findByText("Add credits or upgrade")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Update payment" }),
  ).not.toBeInTheDocument();
});
it("allows a free account without a billing account to use its normal limit actions", async () => {
  statusMock.mockRejectedValue(
    new BillingRequestError(
      "No billing account found for this organization",
      404,
    ),
  );
  setup();
  expect(await screen.findByText("Add credits or upgrade")).toBeVisible();
});
it("does not mistake a billing outage for exhausted usage and allows rechecking", async () => {
  statusMock
    .mockRejectedValueOnce(new Error("Unavailable"))
    .mockResolvedValueOnce(delinquent);
  setup();
  fireEvent.click(await screen.findByRole("button", { name: "Check again" }));
  expect(
    await screen.findByRole("button", { name: "Update payment" }),
  ).toBeEnabled();
  expect(screen.queryByText("Add credits or upgrade")).not.toBeInTheDocument();
});
it("does not offer billing mutations to a non-admin", async () => {
  statusMock.mockRejectedValue(
    new BillingRequestError("Only admins or owners can manage billing", 403),
  );
  setup();
  expect(
    await screen.findByText(/Ask your billing administrator/),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Update payment" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("Add credits or upgrade")).not.toBeInTheDocument();
});
it("never reuses the previous organization's delinquency state", async () => {
  const view = setup();
  await screen.findByRole("button", { name: "Update payment" });
  statusMock.mockResolvedValue({
    hasActiveSubscription: false,
    cancelAtPeriodEnd: false,
  });
  mockAuth = { ...mockAuth, organizationId: "org_other" };
  view.rerender(
    <SWRConfig value={{ provider: () => new Map() }}>
      <BlockedChatBillingRecovery>
        <button>Other organization usage</button>
      </BlockedChatBillingRecovery>
    </SWRConfig>,
  );
  expect(await screen.findByText("Other organization usage")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Update payment" }),
  ).not.toBeInTheDocument();
});
it("rechecks a reopened chat after successful payment without granting access itself", async () => {
  const first = setup();
  await screen.findByRole("button", { name: "Update payment" });
  first.unmount();
  statusMock.mockResolvedValue({
    ...delinquent,
    subscriptionStatus: "active",
    renewalPaymentRequired: undefined,
  });
  setup();
  expect(await screen.findByText("Add credits or upgrade")).toBeVisible();
  expect(portalMock).not.toHaveBeenCalled();
});
it("does not treat an ambiguous organization as a free billing account", async () => {
  statusMock.mockRejectedValue(
    new BillingRequestError("No organization found", 404),
  );
  setup();
  expect(
    await screen.findByRole("button", { name: "Check again" }),
  ).toBeVisible();
  expect(screen.queryByText("Add credits or upgrade")).not.toBeInTheDocument();
});

it("does not recommend credits for delinquency outside automatic recovery", async () => {
  statusMock.mockResolvedValue({
    ...delinquent,
    renewalPaymentRequired: undefined,
    cancelAtPeriodEnd: true,
  });
  setup();
  expect(
    await screen.findByText(/Your subscription needs billing attention/),
  ).toBeVisible();
  expect(screen.queryByText("Add credits or upgrade")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Update payment" }),
  ).not.toBeInTheDocument();
});

it("keeps a manual server-admitted retry available during billing lookup outages", async () => {
  statusMock.mockRejectedValue(new Error("Unavailable"));
  const onRetry = jest.fn();
  render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <BlockedChatBillingRecovery onRetry={onRetry}>
        <button>Upgrade</button>
      </BlockedChatBillingRecovery>
    </SWRConfig>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
  expect(onRetry).toHaveBeenCalledTimes(1);
  expect(
    screen.queryByRole("button", { name: "Upgrade" }),
  ).not.toBeInTheDocument();
});

it.each(["focus", "online"])(
  "rechecks billing on %s after returning or reconnecting",
  async (eventName) => {
    jest.useFakeTimers();
    try {
      const { act } = await import("@testing-library/react");
      let view: ReturnType<typeof setup>;
      await act(async () => {
        view = setup();
      });
      expect(
        screen.getByRole("button", { name: "Update payment" }),
      ).toBeVisible();
      statusMock.mockResolvedValue({
        ...delinquent,
        subscriptionStatus: "active",
        renewalPaymentRequired: undefined,
      });
      await act(async () => {
        jest.advanceTimersByTime(31_000);
      });
      await act(async () => {
        window.dispatchEvent(new Event(eventName));
        jest.advanceTimersByTime(1);
      });
      expect(statusMock).toHaveBeenCalledTimes(2);
      expect(
        screen.queryByRole("button", { name: "Update payment" }),
      ).not.toBeInTheDocument();
      expect(screen.getByText("Add credits or upgrade")).toBeVisible();
      view!.unmount();
    } finally {
      jest.useRealTimers();
    }
  },
);
