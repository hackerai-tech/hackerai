import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockCaptureAuthenticatedEvent = jest.fn();
const mockCaptureUpgradeCtaImpression = jest.fn();
const mockRedirectToPricing = jest.fn();
let mockIsTauri = false;

jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: (...args: unknown[]) =>
    mockCaptureAuthenticatedEvent(...args),
  captureUpgradeCtaImpression: (...args: unknown[]) =>
    mockCaptureUpgradeCtaImpression(...args),
}));

jest.mock("@/app/hooks/usePricingDialog", () => ({
  redirectToPricing: (...args: unknown[]) => mockRedirectToPricing(...args),
}));

jest.mock("@/app/hooks/useTauri", () => ({
  useTauri: () => ({ isTauri: mockIsTauri }),
}));

jest.mock("@/app/download/DownloadSection", () => ({
  useDetectedPlatform: () => ({
    platform: "macos",
    displayName: "macOS",
    downloadUrl: "https://example.com/HackerAI.dmg",
  }),
}));

const { FreeAskComputerActivation } = jest.requireActual<
  typeof import("../FreeAskComputerActivation")
>("../FreeAskComputerActivation");

describe("FreeAskComputerActivation", () => {
  beforeEach(() => {
    mockIsTauri = false;
    mockCaptureAuthenticatedEvent.mockClear();
    mockCaptureUpgradeCtaImpression.mockClear();
    mockRedirectToPricing.mockClear();
  });

  it("renders an accessible responsive trigger and captures exposure", async () => {
    render(<FreeAskComputerActivation />);

    const trigger = screen.getByRole("button", {
      name: "Connect computer for Agent mode",
    });
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveClass("text-foreground");
    expect(trigger.querySelector("svg")).toHaveClass("size-4");
    expect(screen.getByText("Connect Computer")).toHaveClass(
      "hidden",
      "text-muted-foreground",
      "md:inline",
    );

    await waitFor(() => {
      expect(mockCaptureAuthenticatedEvent).toHaveBeenCalledWith(
        "computer_activation_cta_impressed",
        expect.objectContaining({
          surface: "chat_input_computer_activation",
          subscription_tier: "free",
          chat_mode: "ask",
        }),
      );
    });
  });

  it("opens desktop and cloud activation paths with analytics", async () => {
    const user = userEvent.setup();
    render(<FreeAskComputerActivation />);

    await user.click(
      screen.getByRole("button", {
        name: "Connect computer for Agent mode",
      }),
    );

    expect(
      screen.getByTestId("free-ask-computer-activation-popover"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Let Agent work with files and terminal tools on your computer.",
      ),
    ).toBeInTheDocument();
    expect(mockCaptureAuthenticatedEvent).toHaveBeenCalledWith(
      "computer_activation_cta_clicked",
      {
        surface: "chat_input_computer_activation",
        source: "free_ask_computer_activation",
        subscription_tier: "free",
        chat_mode: "ask",
      },
    );
    expect(mockCaptureUpgradeCtaImpression).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "chat_input_computer_activation",
        from_tier: "free",
        cta_text: "Upgrade for Cloud Agent",
      }),
    );

    const download = screen.getByTestId("free-ask-computer-download");
    expect(download).toHaveAttribute(
      "href",
      "https://example.com/HackerAI.dmg",
    );
    expect(download).toHaveAttribute("target", "_blank");

    await user.click(download);
    expect(mockCaptureAuthenticatedEvent).toHaveBeenCalledWith(
      "computer_activation_download_clicked",
      {
        surface: "chat_input_computer_activation",
        source: "free_ask_computer_activation",
        subscription_tier: "free",
        chat_mode: "ask",
        platform: "macos",
      },
    );

    await user.click(
      screen.getByRole("button", {
        name: "Connect computer for Agent mode",
      }),
    );
    await user.click(screen.getByTestId("free-ask-cloud-upgrade"));
    expect(mockRedirectToPricing).toHaveBeenCalledWith({
      surface: "chat_input_computer_activation",
      source: "free_ask_computer_activation",
      from_tier: "free",
      cta_text: "Upgrade for Cloud Agent",
    });
  });

  it("does not render inside HackerAI Desktop", () => {
    mockIsTauri = true;

    render(<FreeAskComputerActivation />);

    expect(
      screen.queryByRole("button", {
        name: "Connect computer for Agent mode",
      }),
    ).not.toBeInTheDocument();
    expect(mockCaptureAuthenticatedEvent).not.toHaveBeenCalled();
  });
});
