import "@testing-library/jest-dom";
import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  BuyExtraUsageDialog,
  getApproximateWeeklyExtraUsageSpend,
  getRecommendedExtraUsagePurchaseAmount,
} from "../BuyExtraUsageDialog";

const mockCaptureEvent = jest.fn();
jest.mock("@/lib/analytics/client", () => ({
  captureAddCreditCtaClick: jest.fn(),
  captureAddCreditCtaImpression: jest.fn(),
  captureAuthenticatedEvent: (...args: unknown[]) => mockCaptureEvent(...args),
  newCheckoutAttemptId: () => "attempt-B",
}));

// convex/react maps to the shared test double (one query result, one action
// mock); requireActual loads that mapped module rather than an automock.
const convexReact = jest.requireActual("convex/react") as {
  setMockQueryResult: (next: unknown) => void;
  useAction: () => jest.Mock<(args: Record<string, unknown>) => unknown>;
};

describe("BuyExtraUsageDialog", () => {
  it("projects a weekly burn from month-to-date extra usage", () => {
    const august15 = Date.UTC(2026, 7, 15);

    expect(getApproximateWeeklyExtraUsageSpend(44, august15)).toBeCloseTo(22);
    expect(getApproximateWeeklyExtraUsageSpend(0, august15)).toBeUndefined();
  });

  it.each([
    [undefined, undefined],
    [0, undefined],
    [9, 15],
    [22, 30],
    [41, 50],
    [51, 55],
  ])("sizes a recent weekly burn of %s to %s", (recentSpend, expected) => {
    expect(getRecommendedExtraUsagePurchaseAmount(recentSpend)).toBe(expected);
  });

  it("offers presets, explains the recommendation, and keeps custom amounts", () => {
    const onPurchase = jest.fn(async () => {});

    render(
      <BuyExtraUsageDialog
        open={true}
        onOpenChange={jest.fn()}
        onPurchase={onPurchase}
        isLoading={false}
        paymentMethodMode="checkout"
        recommendedAmountDollars={30}
      />,
    );

    expect(screen.getByRole("button", { name: /\$15/i })).toBeVisible();
    expect(
      screen.getByRole("button", { name: /\$30 recommended/i }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /\$50/i })).toBeVisible();
    expect(
      screen.getByText("$30 should cover approximately your next week."),
    ).toBeVisible();

    fireEvent.change(screen.getByLabelText("Purchase amount"), {
      target: { value: "$75" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Purchase" }));

    expect(onPurchase).toHaveBeenCalledWith(75);
  });

  it("shows discount, submits the bundle, then restores a standard custom purchase", () => {
    const onPurchase = jest.fn(async () => {});
    render(
      <BuyExtraUsageDialog
        open
        onOpenChange={jest.fn()}
        onPurchase={onPurchase}
        isLoading={false}
        paymentMethodMode="checkout"
        bundlesEnabled
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /\$250 credit Pay \$200 Save 20%/ }),
    );
    expect(screen.getByText("Choose at checkout")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Edit payment method" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Pay $200 for $250 credit" }),
    );
    expect(onPurchase).toHaveBeenLastCalledWith(250, "usage-250-v1");
    fireEvent.change(screen.getByLabelText("Purchase amount"), {
      target: { value: "$75" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Purchase" }));
    expect(onPurchase).toHaveBeenLastCalledWith(75);
  });

  it("disables bundles over the monthly allowance while keeping custom amounts", () => {
    const onPurchase = jest.fn(async () => {});
    const { rerender } = render(
      <BuyExtraUsageDialog
        open
        onOpenChange={jest.fn()}
        onPurchase={onPurchase}
        isLoading={false}
        paymentMethodMode="checkout"
        bundlesEnabled
        bundleCap={{
          capDollars: 2000,
          remainingDollars: 1000,
          resetsAt: Date.UTC(2026, 11, 1),
        }}
      />,
    );
    expect(
      screen.getByText(
        "$1,000 of $2,000 monthly bundle credit left. Resets Dec 1 (UTC).",
      ),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /\$1,000 credit/ }));
    expect(
      screen.getByRole("button", { name: "Pay $700 for $1,000 credit" }),
    ).toBeEnabled();

    // A live allowance update blocks the stale selection with an explanation
    // instead of silently turning the click into a custom purchase.
    rerender(
      <BuyExtraUsageDialog
        open
        onOpenChange={jest.fn()}
        onPurchase={onPurchase}
        isLoading={false}
        paymentMethodMode="checkout"
        bundlesEnabled
        bundleCap={{
          capDollars: 2000,
          remainingDollars: 250,
          resetsAt: Date.UTC(2026, 11, 1),
        }}
      />,
    );
    expect(
      screen.getByRole("button", { name: /^\$1,000 credit Pay/ }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: /\$250 credit/ })).toBeEnabled();
    const staleSubmit = screen.getByRole("button", {
      name: "Pay $700 for $1,000 credit",
    });
    expect(staleSubmit).toBeDisabled();
    expect(
      screen.getByText(
        "This bundle is over your remaining monthly bundle limit. Choose another option.",
      ),
    ).toBeVisible();
    fireEvent.click(staleSubmit);
    expect(onPurchase).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Purchase amount"), {
      target: { value: "$1500" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Purchase" }));
    expect(onPurchase).toHaveBeenLastCalledWith(1500);
  });

  it("lets a pending bundle checkout be resumed when no allowance remains", () => {
    const onPurchase = jest.fn(async () => {});
    render(
      <BuyExtraUsageDialog
        open
        onOpenChange={jest.fn()}
        onPurchase={onPurchase}
        isLoading={false}
        paymentMethodMode="checkout"
        bundlesEnabled
        bundleCap={{
          capDollars: 2000,
          remainingDollars: 0,
          resetsAt: Date.UTC(2026, 11, 1),
          resumableBundleIds: ["usage-1000-v1"],
        }}
      />,
    );

    expect(screen.getByRole("button", { name: /\$250 credit/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /\$1,000 credit/ }));
    fireEvent.click(screen.getByRole("button", { name: "Resume checkout" }));

    expect(onPurchase).toHaveBeenCalledWith(1000, "usage-1000-v1");
  });
});

describe("ExtraUsageSection bundle checkout", () => {
  it("reconciles holds on open and adopts the checkout's original attempt ID", async () => {
    convexReact.setMockQueryResult({
      extra_usage_enabled: true,
      balanceDollars: 0,
      policyVersion: "bundle-cap-v1",
      periodMonth: "2026-11",
      resetsAt: Date.now() + 86_400_000,
      capDollars: 2000,
      usedDollars: 1000,
      pendingDollars: 1000,
      remainingDollars: 0,
      historyComplete: true,
      resumableBundleIds: ["usage-1000-v1"],
    });
    const action = convexReact.useAction();
    action.mockReset();
    // A hash change keeps jsdom on the page instead of navigating away.
    const checkoutUrl = `${window.location.href.split("#")[0]}#stripe-checkout`;
    let purchaseCalls = 0;
    action.mockImplementation(async (args) => {
      if (!("bundleId" in args)) {
        // Reconcile and payment-status calls take no purchase arguments.
        return { released: false, hasPaymentMethod: false };
      }
      purchaseCalls++;
      // The first answer is ambiguous; both name the original attempt A.
      return purchaseCalls === 1
        ? {
            url: null,
            error: "Checkout is taking longer than expected.",
            errorCode: "bundle_checkout_pending",
            retryable: true,
            checkoutAttemptId: "attempt-A",
          }
        : {
            url: checkoutUrl,
            checkoutSessionId: "cs_original",
            checkoutAttemptId: "attempt-A",
            reservationReused: true,
          };
    });

    // Loaded after the analytics mock is registered.
    const { ExtraUsageSection } = require("../../ExtraUsageSection");
    render(<ExtraUsageSection />);
    fireEvent.click(screen.getByRole("button", { name: "Buy credit" }));
    // Opening with a pending checkout reconciles it before the cap refresh.
    expect(action).toHaveBeenCalledWith({});

    fireEvent.click(
      await screen.findByRole("button", { name: /^\$1,000 credit Pay/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Resume checkout" }));
    await waitFor(() => expect(purchaseCalls).toBe(1));
    expect(action).toHaveBeenLastCalledWith(
      expect.objectContaining({ checkoutAttemptId: "attempt-B" }),
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Resume checkout" }),
    );
    await waitFor(() => expect(purchaseCalls).toBe(2));
    expect(action).toHaveBeenLastCalledWith(
      expect.objectContaining({ checkoutAttemptId: "attempt-A" }),
    );
    await waitFor(() =>
      expect(mockCaptureEvent).toHaveBeenCalledWith(
        "add_credit_checkout_started",
        expect.objectContaining({
          checkout_attempt_id: "attempt-A",
          stripe_checkout_session_id: "cs_original",
        }),
      ),
    );
    convexReact.setMockQueryResult(undefined);
  });
});
