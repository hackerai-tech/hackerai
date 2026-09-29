import "@testing-library/jest-dom";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockHandleUpgrade = jest.fn();
const mockFetch = jest.fn();

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
  default: () => null,
}));
jest.mock("../UpgradeConfirmationDialog", () => ({
  __esModule: true,
  default: () => null,
}));

const PricingDialog = require("../PricingDialog")
  .default as typeof import("../PricingDialog").default;

const currentPrice = {
  priceLookupKey: "pro-monthly-plan",
  displayedAmountDollars: 29,
  currency: "usd",
  billingInterval: "month",
  stripePriceId: "price_pro_29",
};

describe("PricingDialog Pro monthly price", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: mockFetch,
    });
  });

  it("keeps checkout disabled until the $29 Stripe Price resolves", async () => {
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
      resolveRequest({ ok: true, json: async () => currentPrice });
    });
    expect(await screen.findByText("29")).toBeVisible();
    expect(screen.getByRole("button", { name: "Get Pro" })).toBeEnabled();
  });

  it("rejects $25 and retries on reopen", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ...currentPrice, displayedAmountDollars: 25 }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => currentPrice });
    const { rerender } = render(<PricingDialog isOpen onClose={jest.fn()} />);
    expect(
      await screen.findByRole("button", { name: "Pricing unavailable" }),
    ).toBeDisabled();
    rerender(<PricingDialog isOpen={false} onClose={jest.fn()} />);
    rerender(<PricingDialog isOpen onClose={jest.fn()} />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("29")).toBeVisible();
    expect(screen.getByRole("button", { name: "Get Pro" })).toBeEnabled();
  });
});
