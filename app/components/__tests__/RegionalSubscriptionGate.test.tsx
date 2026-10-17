import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { redirectToPricing } from "@/app/hooks/usePricingDialog";
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
  priceLookupKey: "pro-monthly-plan",
  currency: "usd",
  billingInterval: "month",
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
    fireEvent.click(screen.getByRole("button", { name: "Get Pro" }));
    expect(mockUpgrade).toHaveBeenCalledWith(
      "pro-monthly-plan",
      undefined,
      undefined,
      "free",
      expect.objectContaining({
        source: "regional_subscription_first",
      }),
    );
    expect(mockCapture).toHaveBeenCalledWith(
      "regional_subscription_first_exposed",
      expect.objectContaining({
        regional_subscription_variant: "test",
        exposure_surface: "composer",
        paywall_version: 2,
      }),
    );
  });

  it("shows a static example without sending a task or opening checkout", async () => {
    render(view());
    await screen.findByText("$29");
    const callsBefore = mockFetch.mock.calls.length;
    const example = screen
      .getByText("See an example workflow")
      .closest("details")!;
    example.open = true;
    fireEvent(example, new Event("toggle"));
    expect(
      screen.getByText("Illustrative example. No task is running."),
    ).toBeVisible();
    expect(mockFetch).toHaveBeenCalledTimes(callsBefore);
    expect(mockUpgrade).not.toHaveBeenCalled();
    expect(screen.queryByText("Send task")).not.toBeInTheDocument();
    expect(mockCapture).toHaveBeenCalledWith(
      "regional_subscription_paywall_action",
      expect.objectContaining({ action: "view_example", paywall_version: 2 }),
    );
  });

  it("keeps plan comparison in the subscription-required flow", async () => {
    render(view());
    await screen.findByText("$29");
    fireEvent.click(screen.getByRole("button", { name: "Compare plans" }));
    expect(redirectToPricing).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "regional_subscription_first",
        from_tier: "free",
      }),
    );
    expect(mockUpgrade).not.toHaveBeenCalled();
  });

  it("does not enable checkout or record an offer exposure for malformed pricing", async () => {
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(
        response(
          url.includes("pro-monthly")
            ? { ...price, displayedAmountDollars: 1 }
            : { assignment: { variant: "test", country: "IN" } },
        ),
      ),
    );
    render(view());
    await screen.findByText("Retry pricing");
    expect(
      screen.queryByRole("button", { name: "Get Pro" }),
    ).not.toBeInTheDocument();
    expect(mockUpgrade).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();
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
    expect(screen.queryByText("Get Pro")).not.toBeInTheDocument();
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
