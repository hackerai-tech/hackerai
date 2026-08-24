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
});
