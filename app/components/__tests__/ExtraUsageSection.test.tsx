import "@testing-library/jest-dom";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockCreatePurchaseSession = jest.fn();
jest.mock("convex/react", () => ({
  useQuery: () => ({ extra_usage_enabled: true, balanceDollars: 0 }),
  useMutation: () => jest.fn(),
  useAction: () => mockCreatePurchaseSession,
}));
jest.mock("@/lib/analytics/client", () => ({
  captureAddCreditCtaClick: jest.fn(),
  captureAddCreditCtaImpression: jest.fn(),
  captureAuthenticatedEvent: jest.fn(),
  newCheckoutAttemptId: () => "test-attempt",
}));
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }));
jest.mock("@/app/components/extra-usage", () => ({
  TurnOffExtraUsageDialog: () => null,
  AdjustSpendingLimitDialog: () => null,
  AutoReloadDialog: () => null,
  AutoReloadDisabledAlert: () => null,
  BuyExtraUsageDialog: ({
    open,
    onPurchase,
  }: {
    open: boolean;
    onPurchase: (amount: number) => void;
  }) =>
    open ? <button onClick={() => onPurchase(30)}>Purchase $30</button> : null,
}));

const { ExtraUsageSection } = require("../ExtraUsageSection");

describe("ExtraUsageSection checkout return", () => {
  beforeEach(() => {
    // Inspect the request without navigating to a real checkout.
    mockCreatePurchaseSession.mockResolvedValue({ url: null });
  });
  afterEach(() => window.history.replaceState(null, "", "/"));

  it("returns to the current chat and excludes stale purchase parameters", async () => {
    window.history.replaceState(
      null,
      "",
      "/c/stopped-chat?extra-usage-purchased=true#pricing",
    );
    render(<ExtraUsageSection />);
    fireEvent.click(screen.getByRole("button", { name: "Buy extra usage" }));
    fireEvent.click(screen.getByRole("button", { name: "Purchase $30" }));

    await waitFor(() =>
      expect(mockCreatePurchaseSession).toHaveBeenCalledWith({
        amountDollars: 30,
        baseUrl: window.location.origin,
        checkoutAttemptId: "test-attempt",
        returnPath: "/c/stopped-chat",
      }),
    );
  });

  it("keeps the return path within the checkout API length limit", async () => {
    window.history.replaceState(null, "", "/" + "a".repeat(401));
    render(<ExtraUsageSection />);
    fireEvent.click(screen.getByRole("button", { name: "Buy extra usage" }));
    fireEvent.click(screen.getByRole("button", { name: "Purchase $30" }));

    await waitFor(() =>
      expect(mockCreatePurchaseSession).toHaveBeenCalledWith(
        expect.objectContaining({ returnPath: "/" }),
      ),
    );
  });
});
