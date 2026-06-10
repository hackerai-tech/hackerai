import "@testing-library/jest-dom";
import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react";
import { ChatSDKError } from "@/lib/errors";
import { TestWrapper } from "../testUtils";

jest.mock("@/lib/analytics/client", () => ({
  captureAddCreditCtaClick: jest.fn(),
  captureAddCreditCtaImpression: jest.fn(),
  captureUpgradeCtaImpression: jest.fn(),
}));

import { MessageErrorState } from "../MessageErrorState";

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
});
