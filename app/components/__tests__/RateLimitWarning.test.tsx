import "@testing-library/jest-dom";
import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { render, screen } from "@testing-library/react";
import { RateLimitWarning } from "../RateLimitWarning";

jest.mock("@/lib/analytics/client", () => ({
  captureAddCreditCtaClick: jest.fn(),
  captureAddCreditCtaImpression: jest.fn(),
  captureAgentRunSpendCapImpression: jest.fn(),
  captureUpgradeCtaImpression: jest.fn(),
}));

jest.mock("@/lib/utils/settings-dialog", () => ({
  openSettingsDialog: jest.fn(),
}));

describe("RateLimitWarning", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("uses generic copy for free monthly exhaustion", () => {
    render(
      <RateLimitWarning
        data={{
          warningType: "token-bucket",
          bucketType: "monthly",
          remainingPercent: 0,
          resetTime: new Date(Date.now() + 60_000),
          subscription: "free",
          capReason: "free_monthly_exhausted",
        }}
        onDismiss={jest.fn()}
      />,
    );

    expect(
      screen.getByText(/You've reached your free monthly usage limit/i),
    ).toHaveTextContent("Upgrade for higher limits");
    expect(screen.queryByText(/Agent/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /keep going/i }),
    ).toBeInTheDocument();
  });

  it("keeps Agent-specific copy for exhausted Agent daily requests", () => {
    render(
      <RateLimitWarning
        data={{
          warningType: "sliding-window",
          remaining: 0,
          resetTime: new Date(Date.now() + 60_000),
          mode: "agent",
          subscription: "free",
        }}
        onDismiss={jest.fn()}
      />,
    );

    expect(screen.getByText(/free Agent requests/i)).toBeInTheDocument();
  });

  it("renders legacy Pro Agent run cap copy without upgrade or add-credit CTAs", () => {
    render(
      <RateLimitWarning
        data={{
          warningType: "agent-run-spend-cap",
          resetTime: new Date(Date.now() + 60_000),
          subscription: "pro",
          mode: "agent",
          runCostDollars: 5.24,
          runCapDollars: 5,
          monthlyRemainingDollars: 20,
          capBasis: "fixed_5_dollars",
          premiumContinuationAllowed: true,
        }}
        onDismiss={jest.fn()}
      />,
    );

    expect(screen.getByText(/Pro Agent run paused/i)).toHaveTextContent(
      "$5.24",
    );
    expect(screen.getByText(/legacy per-run safety cap/i)).toHaveTextContent(
      "Continue to keep working",
    );
    expect(
      screen.queryByRole("button", { name: /upgrade plan/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /add credits/i }),
    ).not.toBeInTheDocument();
  });

  it("uses current-model continuation copy when premium continuation is unavailable", () => {
    render(
      <RateLimitWarning
        data={{
          warningType: "agent-run-spend-cap",
          resetTime: new Date(Date.now() + 60_000),
          subscription: "pro",
          mode: "agent",
          runCostDollars: 5.24,
          runCapDollars: 5,
          monthlyRemainingDollars: 20,
          capBasis: "fixed_5_dollars",
          premiumContinuationAllowed: false,
        }}
        onDismiss={jest.fn()}
      />,
    );

    expect(screen.getByText(/Pro Agent run paused/i)).toHaveTextContent(
      "Continue to keep working",
    );
  });

  it("uses extra usage copy when paid overflow credits are active", () => {
    render(
      <RateLimitWarning
        data={{
          warningType: "extra-usage-active",
          bucketType: "monthly",
          resetTime: new Date(Date.now() + 60_000),
          subscription: "pro",
          capReason: "extra_usage_active",
        }}
        onDismiss={jest.fn()}
      />,
    );

    expect(
      screen.getByText(/You're now using extra usage credits/i),
    ).toHaveTextContent("Your monthly limit resets");
    expect(
      screen.queryByText(/You've reached your monthly usage limit/i),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /view usage/i }),
    ).toBeInTheDocument();
  });

  it("names the spending limit when extra usage balance exists but the monthly cap is hit", () => {
    render(
      <RateLimitWarning
        data={{
          warningType: "token-bucket",
          bucketType: "monthly",
          remainingPercent: 0,
          resetTime: new Date(Date.now() + 60_000),
          subscription: "ultra",
          capReason: "extra_usage_cap",
          cutOff: true,
        }}
        onDismiss={jest.fn()}
      />,
    );

    expect(screen.getByText(/extra usage spending limit/i)).toHaveTextContent(
      "Increase your limit to continue",
    );
    expect(
      screen.queryByText(/extra usage balance is empty/i),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /increase limit/i }),
    ).toBeInTheDocument();
  });
});
