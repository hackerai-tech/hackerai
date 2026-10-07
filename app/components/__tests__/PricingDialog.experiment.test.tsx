import "@testing-library/jest-dom";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

const mockHandleUpgrade = jest.fn();
const mockFetch = jest.fn();
const mockClearBillingReview = jest.fn();
let mockBillingReviewRequired = false;
let mockBilling = {
  data: { hasActiveSubscription: false, cancelAtPeriodEnd: false } as
    | import("@/lib/billing/api-types").SubscriptionCancellationStatus
    | undefined,
  isLoading: false,
  error: undefined as Error | undefined,
  mutate: jest.fn(),
};

jest.mock("@workos-inc/authkit-nextjs/components", () => ({
  useAuth: () => ({ user: { id: "user_free" } }),
}));
jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({
    subscription: "free",
    isCheckingProPlan: false,
    setTeamPricingDialogOpen: jest.fn(),
  }),
}));
jest.mock("@/app/hooks/useUpgrade", () => ({
  useUpgrade: () => ({
    upgradeLoading: false,
    handleUpgrade: mockHandleUpgrade,
    billingReviewRequired: mockBillingReviewRequired,
    clearBillingReview: mockClearBillingReview,
  }),
}));
jest.mock("@/app/hooks/useBillingRecoveryStatus", () => ({
  useBillingRecoveryStatus: () => mockBilling,
}));

jest.mock("@/app/hooks/useTauri", () => ({ navigateToAuth: jest.fn() }));
jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: jest.fn(),
  captureUpgradeCtaImpression: jest.fn(),
}));
jest.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <>{children}</> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
}));
jest.mock("../BillingFrequencySelector", () => ({
  __esModule: true,
  default: ({
    onChange,
  }: {
    onChange: (value: "monthly" | "yearly") => void;
  }) => <button onClick={() => onChange("yearly")}>Yearly</button>,
}));
jest.mock("../UpgradeConfirmationDialog", () => ({
  __esModule: true,
  default: () => null,
}));

const PricingDialog = require("../PricingDialog")
  .default as typeof import("../PricingDialog").default;

describe("PricingDialog prices and billing status", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBillingReviewRequired = false;
    mockBilling = {
      data: { hasActiveSubscription: false, cancelAtPeriodEnd: false },
      isLoading: false,
      error: undefined,
      mutate: jest.fn(),
    };
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: mockFetch,
    });
  });

  it("preserves review controls when a fresh status check fails despite a healthy cached status", async () => {
    mockBillingReviewRequired = true;
    render(<PricingDialog isOpen onClose={jest.fn()} />);
    await act(async () => {
      await Promise.resolve();
    });
    mockFetch.mockRejectedValueOnce(new Error("Billing unavailable") as never);
    await userEvent.click(
      screen.getByRole("button", { name: "Check payment status" }),
    );
    expect(
      await screen.findByText(
        "We couldn't verify your billing status. Please try again.",
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Get billing help" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Get Pro+" })).toBeDisabled();
    expect(mockClearBillingReview).not.toHaveBeenCalled();
    expect(mockBilling.mutate).not.toHaveBeenCalled();
  });

  it("updates cached status and clears review only after a successful fresh check", async () => {
    mockBillingReviewRequired = true;
    render(<PricingDialog isOpen onClose={jest.fn()} />);
    await act(async () => {
      await Promise.resolve();
    });
    const fresh = { hasActiveSubscription: false, cancelAtPeriodEnd: false };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => fresh,
    } as never);
    await userEvent.click(
      screen.getByRole("button", { name: "Check payment status" }),
    );
    await waitFor(() =>
      expect(mockClearBillingReview).toHaveBeenCalledTimes(1),
    );
    expect(mockBilling.mutate).toHaveBeenCalledWith(fresh, {
      revalidate: false,
    });
  });

  it("shows the canceled-renewal review panel and disables plan purchases", async () => {
    mockBilling.data = {
      hasActiveSubscription: false,
      cancelAtPeriodEnd: false,
      billingAccountAvailable: true,
      checkoutRequiresReview: true,
    };
    render(<PricingDialog isOpen onClose={jest.fn()} />);
    expect(
      screen.getByRole("region", { name: "Subscription payment recovery" }),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Get billing help" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Get Pro+" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Get Ultra" })).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Pay invoice" }),
    ).not.toBeInTheDocument();
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("keeps plan purchases disabled while billing status is unknown", async () => {
    mockBilling.data = undefined;
    mockBilling.error = new Error("Billing unavailable");
    render(<PricingDialog isOpen onClose={jest.fn()} />);
    expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Get Pro+" })).toBeDisabled();
    await act(async () => {
      await Promise.resolve();
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("shows $29 immediately without fetching a presentation price", async () => {
    render(<PricingDialog isOpen onClose={jest.fn()} />);
    expect(screen.getByText("29")).toBeVisible();
    expect(screen.queryByText("…")).not.toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Get Pro" }));
    expect(mockHandleUpgrade).toHaveBeenCalledWith(
      "pro-monthly-plan",
      undefined,
      undefined,
      "free",
      expect.objectContaining({ surface: "pricing_dialog" }),
    );
  });

  it("shows the yearly price immediately and selects annual checkout", async () => {
    render(<PricingDialog isOpen onClose={jest.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Yearly" }));
    expect(screen.getByText("24")).toBeVisible();
    expect(mockFetch).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Get Pro" }));
    expect(mockHandleUpgrade).toHaveBeenCalledWith(
      "pro-yearly-plan",
      undefined,
      undefined,
      "free",
      expect.objectContaining({ surface: "pricing_dialog" }),
    );
  });

  it("hides a fast billing check while keeping checkout blocked until it completes", () => {
    jest.useFakeTimers();
    mockBilling.isLoading = true;
    const { rerender } = render(<PricingDialog isOpen onClose={jest.fn()} />);
    expect(screen.getByText("29")).toBeVisible();
    expect(screen.getByRole("button", { name: "Get Pro" })).toBeDisabled();
    act(() => jest.advanceTimersByTime(200));
    expect(
      screen.queryByText("Checking your billing status…"),
    ).not.toBeInTheDocument();
    mockBilling.isLoading = false;
    rerender(<PricingDialog isOpen onClose={jest.fn()} />);
    act(() => jest.advanceTimersByTime(500));
    expect(
      screen.queryByText("Checking your billing status…"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Get Pro" })).toBeEnabled();
  });

  it("shows slow billing checks after 300ms and restarts the delay on reopen", () => {
    jest.useFakeTimers();
    mockBilling.isLoading = true;
    const { rerender } = render(<PricingDialog isOpen onClose={jest.fn()} />);
    act(() => jest.advanceTimersByTime(299));
    expect(
      screen.queryByText("Checking your billing status…"),
    ).not.toBeInTheDocument();
    act(() => jest.advanceTimersByTime(1));
    expect(screen.getByText("Checking your billing status…")).toBeVisible();
    expect(screen.getByRole("button", { name: "Get Pro" })).toBeDisabled();
    rerender(<PricingDialog isOpen={false} onClose={jest.fn()} />);
    rerender(<PricingDialog isOpen onClose={jest.fn()} />);
    expect(
      screen.queryByText("Checking your billing status…"),
    ).not.toBeInTheDocument();
    act(() => jest.advanceTimersByTime(300));
    expect(screen.getByText("Checking your billing status…")).toBeVisible();
    mockBilling.isLoading = false;
    rerender(<PricingDialog isOpen onClose={jest.fn()} />);
    expect(
      screen.queryByText("Checking your billing status…"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Get Pro" })).toBeEnabled();
  });
});
