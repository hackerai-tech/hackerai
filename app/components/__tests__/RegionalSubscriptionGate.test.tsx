import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { RegionalSubscriptionGate } from "../RegionalSubscriptionGate";

let mockUser: { id: string } | null = { id: "user-1" };
let mockSubscription = "free";
const mockFetch = jest.fn();
const mockUpgrade = jest.fn();
const mockCapture = jest.fn();
jest.mock("@workos-inc/authkit-nextjs/components", () => ({
  useAuth: () => ({ user: mockUser }),
}));
jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({
    subscription: mockSubscription,
    isCheckingProPlan: false,
  }),
}));
jest.mock("@/app/hooks/useUpgrade", () => ({
  useUpgrade: () => ({ handleUpgrade: mockUpgrade, upgradeLoading: false }),
}));
jest.mock("@/app/hooks/usePricingDialog", () => ({
  redirectToPricing: jest.fn(),
}));
jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: (...args: unknown[]) => mockCapture(...args),
}));

const price = {
  key: "hac46-pro-monthly-29-pricing",
  variant: "test",
  priceLookupKey: "pro-monthly-plan-29-experiment",
  displayedAmountDollars: 29,
  stripePriceId: "price_29",
};
const response = (body: unknown) => ({ ok: true, json: async () => body });
const view = (running = false) => (
  <RegionalSubscriptionGate running={running}>
    <button>Send task</button>
  </RegionalSubscriptionGate>
);

describe("subscription before task presentation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUser = { id: "user-1" };
    mockSubscription = "free";
    mockCapture.mockReturnValue(true);
    global.fetch = mockFetch;
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(
        response(
          url.includes("pro-monthly")
            ? price
            : { assignment: { variant: "test", country: "IN" } },
        ),
      ),
    );
  });

  it("shows the assigned price before allowing a task and uses the established checkout", async () => {
    render(view());
    expect(screen.queryByText("Send task")).not.toBeInTheDocument();
    await screen.findByText("$29");
    expect(screen.queryByText("Send task")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Subscribe to Pro" }));
    expect(mockUpgrade).toHaveBeenCalledWith(
      "pro-monthly-plan",
      undefined,
      undefined,
      "free",
      expect.objectContaining({
        source: "regional_subscription_first",
        pricing_experiment: expect.objectContaining({
          displayedAmountDollars: 29,
        }),
      }),
    );
    expect(mockCapture).toHaveBeenCalledWith(
      "regional_subscription_first_exposed",
      expect.objectContaining({
        regional_subscription_variant: "test",
        exposure_surface: "composer",
      }),
    );
  });

  it("renders controls and retains zero-usage accounts in the exposure denominator", async () => {
    mockFetch.mockResolvedValue(
      response({ assignment: { variant: "control", country: "PK" } }),
    );
    render(view());
    await screen.findByText("Send task");
    expect(mockCapture).toHaveBeenCalledWith(
      "regional_subscription_first_exposed",
      expect.objectContaining({ regional_subscription_variant: "control" }),
    );
  });

  it.each(["pro", "pro-plus", "ultra", "team"])(
    "does not gate %s accounts",
    (subscription) => {
      mockSubscription = subscription;
      render(view());
      expect(screen.getByText("Send task")).toBeVisible();
      expect(mockFetch).not.toHaveBeenCalled();
    },
  );

  it("removes the paywall immediately when subscription state becomes paid", async () => {
    const { rerender } = render(view());
    await screen.findByText("$29");
    mockSubscription = "pro";
    rerender(view());
    expect(screen.getByText("Send task")).toBeVisible();
    expect(screen.queryByText("Subscribe to Pro")).not.toBeInTheDocument();
  });

  it("keeps active task controls available", () => {
    render(view(true));
    expect(screen.getByText("Send task")).toBeVisible();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("falls back to normal access on assignment failure", async () => {
    mockFetch.mockRejectedValue(new Error("offline"));
    render(view());
    await screen.findByText("Send task");
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it("does not show an invented price or enable checkout when pricing fails, and supports retry", async () => {
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes("pro-monthly")
          ? { ok: false }
          : response({ assignment: { variant: "test", country: "BD" } }),
      ),
    );
    render(view());
    await screen.findByText("Retry pricing");
    expect(screen.queryByText("$25")).not.toBeInTheDocument();
    expect(screen.queryByText("Send task")).not.toBeInTheDocument();
    mockFetch.mockResolvedValue(response(price));
    fireEvent.click(screen.getByText("Retry pricing"));
    await screen.findByText("$29");
  });

  it("rechecks rollback on focus", async () => {
    render(view());
    await screen.findByText("$29");
    mockFetch.mockResolvedValue(response({ assignment: null }));
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(screen.getByText("Send task")).toBeVisible());
  });
});
