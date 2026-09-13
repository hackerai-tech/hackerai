import "@testing-library/jest-dom";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockHandleUpgrade = jest.fn();
const mockFetch = jest.fn();
const mockCaptureAuthenticatedEvent = jest.fn();

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
  }),
}));

jest.mock("@/app/hooks/useTauri", () => ({
  navigateToAuth: jest.fn(),
}));

jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: mockCaptureAuthenticatedEvent,
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
  default: () => null,
}));

jest.mock("../UpgradeConfirmationDialog", () => ({
  __esModule: true,
  default: () => null,
}));

const PricingDialog = require("../PricingDialog")
  .default as typeof import("../PricingDialog").default;

describe("PricingDialog HAC-46 assignment", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCaptureAuthenticatedEvent.mockReturnValue(true);
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: mockFetch,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("keeps monthly Pro disabled until the $29 assignment resolves", async () => {
    let resolveRequest: (value: unknown) => void = () => {};
    mockFetch.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );

    render(<PricingDialog isOpen onClose={jest.fn()} />);

    expect(screen.getByText("…")).toBeVisible();
    expect(screen.getByRole("button", { name: "Get Pro" })).toBeDisabled();

    await act(async () => {
      resolveRequest({
        ok: true,
        json: async () => ({
          key: "hac46-pro-monthly-29-pricing",
          variant: "test",
          priceLookupKey: "pro-monthly-plan-29-experiment",
          displayedAmountDollars: 29,
          stripePriceId: "price_pro_29",
        }),
      });
    });

    expect(await screen.findByText("29")).toBeVisible();
    expect(screen.getByRole("button", { name: "Get Pro" })).toBeEnabled();
  });

  it("keeps checkout disabled after an assignment failure and retries when reopened", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        key: "hac46-pro-monthly-29-pricing",
        variant: "control",
        priceLookupKey: "pro-monthly-plan",
        displayedAmountDollars: 25,
        stripePriceId: "price_pro_25",
      }),
    });

    const { rerender } = render(<PricingDialog isOpen onClose={jest.fn()} />);

    expect(
      await screen.findByRole("button", { name: "Pricing unavailable" }),
    ).toBeDisabled();
    expect(screen.getByText("—")).toBeVisible();

    rerender(<PricingDialog isOpen={false} onClose={jest.fn()} />);
    rerender(<PricingDialog isOpen onClose={jest.fn()} />);

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("25")).toBeVisible();
    expect(screen.getByRole("button", { name: "Get Pro" })).toBeEnabled();
  });

  it("retries experiment exposure until PostHog accepts it", async () => {
    jest.useFakeTimers();
    mockCaptureAuthenticatedEvent
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        key: "hac46-pro-monthly-29-pricing",
        variant: "test",
        priceLookupKey: "pro-monthly-plan-29-experiment",
        displayedAmountDollars: 29,
        stripePriceId: "price_pro_29",
      }),
    });

    render(<PricingDialog isOpen onClose={jest.fn()} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("29")).toBeVisible();
    expect(mockCaptureAuthenticatedEvent).toHaveBeenCalledTimes(1);

    act(() => jest.advanceTimersByTime(500));
    expect(mockCaptureAuthenticatedEvent).toHaveBeenCalledTimes(2);

    act(() => jest.advanceTimersByTime(500));
    expect(mockCaptureAuthenticatedEvent).toHaveBeenCalledTimes(3);
  });
});
