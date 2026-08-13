import "@testing-library/jest-dom";
import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockGetSubscriptionCancellationStatus = jest.fn();
const mockKeepSubscription = jest.fn();
const mockRedirectToBillingPortal = jest.fn();
const mockSetMigrateFromPentestgptDialogOpen = jest.fn();
const mockToastSuccess = jest.fn();
const mockToastError = jest.fn();
const mockCaptureAuthenticatedEvent = jest.fn();
let mockOnCancellationCompleted:
  | ((result: {
      cancelAtPeriodEnd: boolean;
      currentPeriodEnd?: number;
    }) => void)
  | undefined;

jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({
    subscription: "pro",
    setMigrateFromPentestgptDialogOpen: mockSetMigrateFromPentestgptDialogOpen,
  }),
}));

jest.mock("@/app/hooks/usePentestgptMigration", () => ({
  usePentestgptMigration: () => ({ isMigrating: false }),
}));

jest.mock("@/app/hooks/usePricingDialog", () => ({
  redirectToPricing: jest.fn(),
}));

jest.mock("@/lib/billing/client", () => ({
  getSubscriptionCancellationStatus: mockGetSubscriptionCancellationStatus,
  keepSubscription: mockKeepSubscription,
  redirectToBillingPortal: mockRedirectToBillingPortal,
}));

jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: mockCaptureAuthenticatedEvent,
}));

jest.mock("sonner", () => ({
  toast: {
    success: mockToastSuccess,
    error: mockToastError,
  },
}));

jest.mock("../DeleteAccountDialog", () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock("../CancelSubscriptionDialog", () => ({
  __esModule: true,
  default: (props: {
    onCancellationCompleted?: (result: {
      cancelAtPeriodEnd: boolean;
      currentPeriodEnd?: number;
    }) => void;
  }) => {
    mockOnCancellationCompleted = props.onCancellationCompleted;
    return null;
  },
}));

const AccountTab = require("../AccountTab")
  .AccountTab as typeof import("../AccountTab").AccountTab;

describe("AccountTab", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOnCancellationCompleted = undefined;
    window.history.replaceState(null, "", "/");
  });

  it("shows scheduled cancellation state instead of the cancel action", async () => {
    const currentPeriodEnd = Date.UTC(2026, 6, 31, 12);
    const expectedPeriodEnd = new Intl.DateTimeFormat(undefined, {
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(new Date(currentPeriodEnd));

    mockGetSubscriptionCancellationStatus.mockResolvedValue({
      hasActiveSubscription: true,
      cancelAtPeriodEnd: true,
      currentPeriodEnd,
    } as never);

    render(<AccountTab />);

    expect(await screen.findByText("Cancellation scheduled.")).toBeVisible();
    expect(
      screen.getByText(`Your plan stays active until ${expectedPeriodEnd}.`),
    ).toBeVisible();

    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: /manage/i })[0]);

    await waitFor(() => {
      expect(screen.getByText("Cancellation scheduled")).toBeVisible();
    });
    expect(screen.getByText("Keep plan")).toBeVisible();
    expect(screen.queryByText("Cancel subscription")).not.toBeInTheDocument();
  });

  it("keeps the cancel action when cancellation is not scheduled", async () => {
    mockGetSubscriptionCancellationStatus.mockResolvedValue({
      hasActiveSubscription: true,
      cancelAtPeriodEnd: false,
    } as never);

    render(<AccountTab />);

    await waitFor(() => {
      expect(mockGetSubscriptionCancellationStatus).toHaveBeenCalledTimes(1);
    });

    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: /manage/i })[0]);

    expect(screen.getByText("Cancel subscription")).toBeVisible();
    expect(
      screen.queryByText("Cancellation scheduled."),
    ).not.toBeInTheDocument();
  });

  it("opens the billing portal from the payment manage action", async () => {
    mockGetSubscriptionCancellationStatus.mockResolvedValue({
      hasActiveSubscription: true,
      cancelAtPeriodEnd: false,
    } as never);
    mockRedirectToBillingPortal.mockResolvedValue("#billing" as never);

    render(<AccountTab />);

    await waitFor(() => {
      expect(mockGetSubscriptionCancellationStatus).toHaveBeenCalledTimes(1);
    });

    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: /^manage$/i })[1]);

    await waitFor(() => {
      expect(mockRedirectToBillingPortal).toHaveBeenCalledTimes(1);
    });
    expect(window.location.hash).toBe("#billing");
  });

  it("does not open the payment portal before billing status resolves", async () => {
    mockGetSubscriptionCancellationStatus.mockReturnValue(
      new Promise((resolve) => {
        void resolve;
      }) as never,
    );

    render(<AccountTab />);

    const paymentButton = screen.getAllByRole("button", {
      name: /^manage$/i,
    })[1];
    expect(paymentButton).toBeDisabled();

    const user = userEvent.setup();
    await user.click(paymentButton);
    expect(mockRedirectToBillingPortal).not.toHaveBeenCalled();
  });

  it("shows a past-due warning and opens payment method update directly", async () => {
    mockGetSubscriptionCancellationStatus.mockResolvedValue({
      hasActiveSubscription: true,
      cancelAtPeriodEnd: false,
      subscriptionStatus: "past_due",
      latestInvoiceId: "in_past_due",
    } as never);
    mockRedirectToBillingPortal.mockResolvedValue("#payment-method" as never);

    render(<AccountTab />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Your renewal payment failed—update your payment method to keep your plan.",
    );
    expect(mockCaptureAuthenticatedEvent).toHaveBeenCalledWith(
      "recovery_prompt_impressed",
      expect.objectContaining({
        surface: "account_settings",
        subscription_tier: "pro",
        subscription_status: "past_due",
        stripe_invoice_id: "in_past_due",
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
      expect.objectContaining({
        surface: "account_settings",
        stripe_invoice_id: "in_past_due",
      }),
    );
    expect(window.location.hash).toBe("#payment-method");
  });

  it("does not offer the direct payment update flow after retries are exhausted", async () => {
    mockGetSubscriptionCancellationStatus.mockResolvedValue({
      hasActiveSubscription: true,
      cancelAtPeriodEnd: false,
      subscriptionStatus: "unpaid",
      latestInvoiceId: "in_unpaid",
    } as never);
    mockRedirectToBillingPortal.mockResolvedValue("#billing" as never);

    render(<AccountTab />);

    await waitFor(() => {
      expect(mockGetSubscriptionCancellationStatus).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: /^manage$/i })[1]);

    await waitFor(() => {
      expect(mockRedirectToBillingPortal).toHaveBeenCalledWith(undefined);
    });
    expect(mockCaptureAuthenticatedEvent).not.toHaveBeenCalledWith(
      "billing_past_due_banner_impressed",
      expect.anything(),
    );
  });

  it("updates the tab when cancellation is scheduled from the dialog", async () => {
    const currentPeriodEnd = Date.UTC(2026, 6, 31, 12);
    const expectedPeriodEnd = new Intl.DateTimeFormat(undefined, {
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(new Date(currentPeriodEnd));

    mockGetSubscriptionCancellationStatus.mockResolvedValue({
      hasActiveSubscription: true,
      cancelAtPeriodEnd: false,
    } as never);

    render(<AccountTab />);

    await waitFor(() => {
      expect(mockGetSubscriptionCancellationStatus).toHaveBeenCalledTimes(1);
    });

    act(() => {
      mockOnCancellationCompleted?.({
        cancelAtPeriodEnd: true,
        currentPeriodEnd,
      });
    });

    expect(await screen.findByText("Cancellation scheduled.")).toBeVisible();
    expect(
      screen.getByText(`Your plan stays active until ${expectedPeriodEnd}.`),
    ).toBeVisible();

    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: /manage/i })[0]);

    expect(screen.getByText("Cancellation scheduled")).toBeVisible();
    expect(screen.getByText("Keep plan")).toBeVisible();
    expect(screen.queryByText("Cancel subscription")).not.toBeInTheDocument();
  });

  it("shows no active subscription after an overdue subscription is canceled", async () => {
    mockGetSubscriptionCancellationStatus.mockResolvedValue({
      hasActiveSubscription: true,
      cancelAtPeriodEnd: false,
    } as never);

    render(<AccountTab />);

    await waitFor(() => {
      expect(mockGetSubscriptionCancellationStatus).toHaveBeenCalledTimes(1);
    });

    act(() => {
      mockOnCancellationCompleted?.({ cancelAtPeriodEnd: false });
    });

    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: /manage/i })[0]);

    expect(screen.getByText("No active subscription")).toBeVisible();
    expect(screen.queryByText("Keep plan")).not.toBeInTheDocument();
    expect(screen.queryByText("Cancel subscription")).not.toBeInTheDocument();
  });

  it("keeps the plan and restores the cancel action from the manage menu", async () => {
    const currentPeriodEnd = Date.UTC(2026, 6, 31, 12);

    mockGetSubscriptionCancellationStatus.mockResolvedValue({
      hasActiveSubscription: true,
      cancelAtPeriodEnd: true,
      currentPeriodEnd,
    } as never);
    mockKeepSubscription.mockResolvedValue({
      kept: true,
      cancelAtPeriodEnd: false,
      currentPeriodEnd,
      alreadyKept: false,
    } as never);

    render(<AccountTab />);

    expect(await screen.findByText("Cancellation scheduled.")).toBeVisible();

    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: /manage/i })[0]);
    await user.click(screen.getByText("Keep plan"));

    await waitFor(() => {
      expect(mockKeepSubscription).toHaveBeenCalledTimes(1);
      expect(mockToastSuccess).toHaveBeenCalledWith(
        "Cancellation removed. Your plan will renew as usual.",
      );
    });

    expect(
      screen.queryByText("Cancellation scheduled."),
    ).not.toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: /manage/i })[0]);

    expect(screen.getByText("Cancel subscription")).toBeVisible();
    expect(screen.queryByText("Keep plan")).not.toBeInTheDocument();
  });

  it("leaves scheduled cancellation visible when keeping the plan fails", async () => {
    const currentPeriodEnd = Date.UTC(2026, 6, 31, 12);
    let rejectKeepPlan: (error: Error) => void = () => {};

    mockGetSubscriptionCancellationStatus.mockResolvedValue({
      hasActiveSubscription: true,
      cancelAtPeriodEnd: true,
      currentPeriodEnd,
    } as never);
    mockKeepSubscription.mockReturnValue(
      new Promise((_, reject) => {
        rejectKeepPlan = reject;
      }) as never,
    );

    render(<AccountTab />);

    expect(await screen.findByText("Cancellation scheduled.")).toBeVisible();

    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: /manage/i })[0]);
    await user.click(screen.getByText("Keep plan"));

    expect(screen.getByRole("button", { name: /keeping/i })).toBeVisible();

    act(() => {
      rejectKeepPlan(new Error("Stripe update failed"));
    });

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("Stripe update failed");
    });

    expect(screen.getByText("Cancellation scheduled.")).toBeVisible();
    expect(screen.getAllByRole("button", { name: /manage/i })[0]).toBeVisible();

    await user.click(screen.getAllByRole("button", { name: /manage/i })[0]);

    expect(screen.getByText("Keep plan")).toBeVisible();
    expect(screen.queryByText("Cancel subscription")).not.toBeInTheDocument();
  });

  it("does not offer cancellation when no active subscription is found", async () => {
    mockGetSubscriptionCancellationStatus.mockResolvedValue({
      hasActiveSubscription: false,
      cancelAtPeriodEnd: false,
    } as never);

    render(<AccountTab />);

    await waitFor(() => {
      expect(mockGetSubscriptionCancellationStatus).toHaveBeenCalledTimes(1);
    });

    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: /manage/i })[0]);

    expect(screen.getByText("No active subscription")).toBeVisible();
    expect(screen.queryByText("Cancel subscription")).not.toBeInTheDocument();
  });
});
