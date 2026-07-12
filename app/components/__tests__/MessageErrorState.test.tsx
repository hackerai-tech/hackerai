import "@testing-library/jest-dom";
import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { ChatSDKError, serializeChatSDKErrorForStream } from "@/lib/errors";
import { getPaidDailyFreeAllowanceCtaText } from "@/lib/limit-pressure";

jest.mock("@/app/contexts/GlobalState", () => ({
  GlobalStateProvider: ({ children }: { children: ReactNode }) => children,
  useGlobalState: () => ({ subscription: "pro" }),
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

const { TestWrapper } = require("../testUtils");
const { MessageErrorState } = require("../MessageErrorState");
const {
  capturePaidDailyFreeAllowanceClick,
  capturePaidDailyFreeAllowanceImpression,
} = require("@/lib/analytics/client");

describe("MessageErrorState", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("does not offer same-payload retry for provider content blocks", () => {
    const error = new ChatSDKError(
      "forbidden:stream",
      "The model provider blocked this request because the conversation content was flagged by its safety system. Edit your last message or remove sensitive or raw tool output, then try again.",
      {
        providerErrorCategory: "content_blocked",
        providerStatusCode: 403,
        providerErrorRetriable: false,
      },
    );

    render(
      <TestWrapper>
        <MessageErrorState
          error={error}
          onRetry={jest.fn()}
          onReconnect={jest.fn()}
        />
      </TestWrapper>,
    );

    expect(
      screen.getByText(/flagged by its safety system/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Retrying with the same conversation/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^retry$/i })).toBeNull();
    expect(
      screen.getByRole("button", { name: /new chat/i }),
    ).toBeInTheDocument();
  });

  it("keeps retry available for ordinary errors", () => {
    const onRetry = jest.fn();

    render(
      <TestWrapper>
        <MessageErrorState
          error={new Error("Network broke")}
          onRetry={onRetry}
        />
      </TestWrapper>,
    );

    fireEvent.click(screen.getByRole("button", { name: /^retry$/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("shows a focused Add Credits plus free Ask CTA when allowance is available", async () => {
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
          costRemainingDollars: 0.25,
        },
      },
    );

    render(
      <TestWrapper>
        <MessageErrorState error={error} onRetry={onRetry} mode="ask" />
      </TestWrapper>,
    );

    expect(screen.getByRole("button", { name: "Add Credits" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Try Again" })).toBeNull();
    expect(screen.queryByRole("button", { name: "View Usage" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Upgrade Plan" })).toBeNull();

    const freeRequestButton = screen.getByRole("button", {
      name: getPaidDailyFreeAllowanceCtaText("ask"),
    });
    expect(freeRequestButton).toBeVisible();
    expect(capturePaidDailyFreeAllowanceImpression).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "message_error_state",
        cta_text: getPaidDailyFreeAllowanceCtaText("ask"),
        allowance_requests_remaining: 1,
        allowance_cost_remaining_dollars: 0.25,
      }),
    );

    await user.click(freeRequestButton);

    expect(capturePaidDailyFreeAllowanceClick).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "message_error_state",
        cta_text: getPaidDailyFreeAllowanceCtaText("ask"),
      }),
    );
    expect(onRetry).toHaveBeenCalledWith({
      limitRescue: { type: "paid_daily_free_allowance" },
    });
  });

  it("offers the daily allowance for a structured Agent stream error", () => {
    const error = new ChatSDKError(
      "rate_limit:chat",
      "You've hit your monthly usage limit.",
      {
        capReason: "monthly_exhausted",
        paidDailyFreeAllowance: {
          type: "paid_daily_free_allowance",
          available: true,
          requestsRemaining: 1,
          costRemainingDollars: 0.25,
        },
      },
    );

    render(
      <TestWrapper>
        <MessageErrorState
          error={new Error(serializeChatSDKErrorForStream(error))}
          onRetry={jest.fn()}
          mode="agent"
        />
      </TestWrapper>,
    );

    expect(
      screen.getByRole("button", {
        name: getPaidDailyFreeAllowanceCtaText("agent"),
      }),
    ).toBeVisible();
    expect(
      screen.getByText(/up to \$0\.25 of free usage today/i),
    ).toHaveTextContent(
      "Continue this request in Agent mode with our low-cost model",
    );
  });

  it("keeps the allowance explanation grammatical without cost metadata", () => {
    const error = new ChatSDKError(
      "rate_limit:chat",
      "You've hit your monthly usage limit.",
      {
        capReason: "monthly_exhausted",
        paidDailyFreeAllowance: {
          type: "paid_daily_free_allowance",
          available: true,
          requestsRemaining: 1,
        },
      },
    );

    render(
      <TestWrapper>
        <MessageErrorState error={error} onRetry={jest.fn()} mode="agent" />
      </TestWrapper>,
    );

    expect(screen.getByText(/some of free usage today/i)).toBeVisible();
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

    render(
      <TestWrapper>
        <MessageErrorState error={error} onRetry={jest.fn()} />
      </TestWrapper>,
    );

    expect(
      screen.queryByRole("button", {
        name: getPaidDailyFreeAllowanceCtaText("ask"),
      }),
    ).toBeNull();
  });
});
