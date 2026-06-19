import "@testing-library/jest-dom";
import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { render, screen } from "@testing-library/react";
import { RateLimitWarning } from "../RateLimitWarning";

jest.mock("@/lib/analytics/client", () => ({
  captureAddCreditCtaClick: jest.fn(),
  captureAddCreditCtaImpression: jest.fn(),
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
});
