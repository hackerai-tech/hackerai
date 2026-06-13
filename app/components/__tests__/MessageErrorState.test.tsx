import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { ChatSDKError } from "@/lib/errors";

jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({ subscription: "pro" }),
}));

jest.mock("../MemoizedMarkdown", () => ({
  MemoizedMarkdown: ({ content }: { content: string }) => <p>{content}</p>,
}));

jest.mock("@/lib/utils/settings-dialog", () => ({
  openSettingsDialog: jest.fn(),
}));

jest.mock("@/app/hooks/usePricingDialog", () => ({
  redirectToPricing: jest.fn(),
}));

jest.mock("@/lib/analytics/client", () => ({
  captureAddCreditCtaClick: jest.fn(),
  captureAddCreditCtaImpression: jest.fn(),
  capturePaidDailyFreeAllowanceClick: jest.fn(),
  capturePaidDailyFreeAllowanceImpression: jest.fn(),
  captureUpgradeCtaImpression: jest.fn(),
}));

const { MessageErrorState } = require("../MessageErrorState");
const {
  capturePaidDailyFreeAllowanceClick,
  capturePaidDailyFreeAllowanceImpression,
} = require("@/lib/analytics/client");

describe("MessageErrorState paid daily free allowance", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("shows Add Credits plus a secondary free-request retry CTA when allowance is available", async () => {
    const user = userEvent.setup();
    const onRetry = jest.fn();
    const error = new ChatSDKError(
      "rate_limit:chat",
      "You've hit your monthly usage limit.",
      {
        capReason: "monthly_exhausted",
        paidDailyFreeAllowance: {
          type: "paid_daily_free_allowance",
          available: true,
          requestsRemaining: 1,
          costRemainingDollars: 0.1,
        },
      },
    );

    render(<MessageErrorState error={error} onRetry={onRetry} />);

    expect(screen.getByRole("button", { name: "Add Credits" })).toBeVisible();
    const freeRequestButton = screen.getByRole("button", {
      name: "Use today's free request",
    });
    expect(freeRequestButton).toBeVisible();
    expect(capturePaidDailyFreeAllowanceImpression).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "message_error_state",
        cta_text: "Use today's free request",
        allowance_requests_remaining: 1,
        allowance_cost_remaining_dollars: 0.1,
      }),
    );

    await user.click(freeRequestButton);

    expect(capturePaidDailyFreeAllowanceClick).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "message_error_state",
        cta_text: "Use today's free request",
      }),
    );
    expect(onRetry).toHaveBeenCalledWith({
      limitRescue: { type: "paid_daily_free_allowance" },
    });
  });

  it("does not show the free-request CTA when allowance is unavailable", () => {
    const error = new ChatSDKError(
      "rate_limit:chat",
      "You've hit your monthly usage limit.",
      {
        capReason: "monthly_exhausted",
        paidDailyFreeAllowance: {
          type: "paid_daily_free_allowance",
          available: false,
          unavailableReason: "request_limit_reached",
        },
      },
    );

    render(<MessageErrorState error={error} onRetry={jest.fn()} />);

    expect(
      screen.queryByRole("button", { name: "Use today's free request" }),
    ).toBeNull();
  });
});
