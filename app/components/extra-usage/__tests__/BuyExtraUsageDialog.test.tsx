import "@testing-library/jest-dom";
import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  BuyExtraUsageDialog,
  getApproximateWeeklyExtraUsageSpend,
  getRecommendedExtraUsagePurchaseAmount,
} from "../BuyExtraUsageDialog";

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
