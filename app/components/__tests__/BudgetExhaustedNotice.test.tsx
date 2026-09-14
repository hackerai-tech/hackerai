jest.mock("../BlockedChatBillingRecovery", () => ({
  BlockedChatBillingRecovery: ({
    children,
  }: {
    children: import("react").ReactNode;
  }) => children,
}));
import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react";
import type { SubscriptionTier } from "@/types";

let mockSubscription: SubscriptionTier = "pro";
let mockCheckingPlan = false;
const mockUseQuery = jest.fn();
jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({
    subscription: mockSubscription,
    isCheckingProPlan: mockCheckingPlan,
  }),
}));
jest.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));
jest.mock("@/app/hooks/usePricingDialog", () => ({
  redirectToPricing: jest.fn(),
}));
jest.mock("@/lib/utils/settings-dialog", () => ({
  openSettingsDialog: jest.fn(),
}));

const { BudgetExhaustedNotice } = require("../BudgetExhaustedNotice");
const { openSettingsDialog } = require("@/lib/utils/settings-dialog");
const { redirectToPricing } = require("@/app/hooks/usePricingDialog");

const emptyEntitlement = {
  extraUsageAvailable: false,
  reason: "empty",
  hasBalance: false,
  autoReloadEnabled: false,
};
const availableEntitlement = {
  ...emptyEntitlement,
  extraUsageAvailable: true,
  reason: "available",
  hasBalance: true,
};

describe("BudgetExhaustedNotice", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSubscription = "pro";
    mockCheckingPlan = false;
    mockUseQuery.mockReturnValue(emptyEntitlement);
  });

  it("opens Extra Usage from the empty-balance notice without starting a run", () => {
    const onContinue = jest.fn();
    render(<BudgetExhaustedNotice onContinue={onContinue} />);

    fireEvent.click(screen.getByRole("button", { name: "Add credits" }));

    expect(openSettingsDialog).toHaveBeenCalledWith("Extra Usage");
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("reacts to a credited purchase and continues only when clicked", () => {
    const onContinue = jest.fn();
    const { rerender } = render(
      <BudgetExhaustedNotice onContinue={onContinue} />,
    );
    expect(screen.getByRole("button", { name: "Add credits" })).toBeEnabled();

    mockUseQuery.mockReturnValue(availableEntitlement);
    rerender(<BudgetExhaustedNotice onContinue={onContinue} />);

    expect(
      screen.queryByRole("button", { name: "Add credits" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/Continue to resume where it stopped/),
    ).toBeInTheDocument();
    expect(onContinue).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(onContinue).toHaveBeenCalledWith();
  });

  it("shows Continue when reopening a stopped chat after topping up", () => {
    mockUseQuery.mockReturnValue(availableEntitlement);
    render(<BudgetExhaustedNotice onContinue={jest.fn()} />);

    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });

  it("offers spending-limit recovery despite having credits and updates after the cap changes", () => {
    mockUseQuery.mockReturnValue({
      ...availableEntitlement,
      extraUsageAvailable: false,
      reason: "monthly_cap_exhausted",
      monthlyRemainingDollars: 0,
    });
    const { rerender } = render(
      <BudgetExhaustedNotice onContinue={jest.fn()} />,
    );

    expect(
      screen.queryByRole("button", { name: "Continue" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Manage spending limit" }),
    );
    expect(openSettingsDialog).toHaveBeenCalledWith("Extra Usage");
    expect(screen.getByText(/Extra Usage spending limit/)).toBeInTheDocument();

    mockUseQuery.mockReturnValue(availableEntitlement);
    rerender(<BudgetExhaustedNotice onContinue={jest.fn()} />);
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });

  it("directs funded but disabled Extra Usage to settings", () => {
    mockUseQuery.mockReturnValue({
      ...availableEntitlement,
      extraUsageAvailable: false,
      reason: "disabled",
    });
    render(<BudgetExhaustedNotice onContinue={jest.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Enable Extra Usage" }));
    expect(openSettingsDialog).toHaveBeenCalledWith("Extra Usage");
    expect(
      screen.queryByRole("button", { name: "Continue" }),
    ).not.toBeInTheDocument();
  });

  it("does not treat auto-reload with an empty wallet as a completed top-up", () => {
    mockUseQuery.mockReturnValue({
      ...availableEntitlement,
      hasBalance: false,
      autoReloadEnabled: true,
    });
    render(<BudgetExhaustedNotice onContinue={jest.fn()} />);

    expect(screen.getByRole("button", { name: "Add credits" })).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "Continue" }),
    ).not.toBeInTheDocument();
  });

  it("allows a manual server recheck for resets or recovered billing failures", () => {
    const onContinue = jest.fn();
    render(<BudgetExhaustedNotice onContinue={onContinue} />);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("does not offer a retry when there is no continuation handler", () => {
    render(<BudgetExhaustedNotice />);

    expect(screen.getByRole("button", { name: "Add credits" })).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "Try again" }),
    ).not.toBeInTheDocument();
  });

  it("waits for live wallet data before recommending a purchase", () => {
    mockUseQuery.mockReturnValue(undefined);
    const onContinue = jest.fn();
    render(<BudgetExhaustedNotice onContinue={onContinue} />);

    expect(
      screen.getByRole("button", { name: "Checking usage…" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("keeps an unknown entitlement recoverable without claiming that credits are empty", () => {
    mockUseQuery.mockReturnValue(null);
    render(<BudgetExhaustedNotice onContinue={jest.fn()} />);

    expect(screen.getByRole("button", { name: "Manage usage" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("offers an upgrade for free users without consulting a personal wallet", () => {
    mockSubscription = "free";
    mockUseQuery.mockReturnValue(undefined);
    render(<BudgetExhaustedNotice onContinue={jest.fn()} />);

    expect(mockUseQuery).toHaveBeenCalledWith(expect.anything(), "skip");
    fireEvent.click(screen.getByRole("button", { name: "Upgrade plan" }));
    expect(redirectToPricing).toHaveBeenCalledWith(
      expect.objectContaining({
        from_tier: "free",
        surface: "budget_exhausted_notice",
      }),
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("routes team members to usage without offering a personal wallet purchase", () => {
    mockSubscription = "team";
    mockUseQuery.mockReturnValue(undefined);
    render(<BudgetExhaustedNotice onContinue={jest.fn()} />);

    expect(mockUseQuery).toHaveBeenCalledWith(expect.anything(), "skip");
    fireEvent.click(screen.getByRole("button", { name: "Manage usage" }));
    expect(openSettingsDialog).toHaveBeenCalledWith("Usage");
    expect(
      screen.queryByRole("button", { name: "Add credits" }),
    ).not.toBeInTheDocument();
  });
});
