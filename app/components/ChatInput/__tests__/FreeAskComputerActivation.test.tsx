import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockCaptureAuthenticatedEvent = jest.fn();
const mockCaptureUpgradeCtaImpression = jest.fn();
const mockRedirectToPricing = jest.fn();
let mockIsTauri = false;
let mockDetectedPlatform = {
  platform: "macos",
  displayName: "macOS",
  downloadUrl: "https://example.com/HackerAI.dmg",
};

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
  useDetectedPlatform: () => mockDetectedPlatform,
}));

const { FreeAskComputerActivation } = jest.requireActual<
  typeof import("../FreeAskComputerActivation")
>("../FreeAskComputerActivation");

describe("FreeAskComputerActivation", () => {
  beforeEach(() => {
    mockIsTauri = false;
    mockDetectedPlatform = {
      platform: "macos",
      displayName: "macOS",
      downloadUrl: "https://example.com/HackerAI.dmg",
    };
    mockCaptureAuthenticatedEvent.mockClear();
    mockCaptureUpgradeCtaImpression.mockClear();
    mockRedirectToPricing.mockClear();
  });

  it("renders an accessible responsive trigger and captures exposure", async () => {
    render(<FreeAskComputerActivation />);

    const trigger = screen.getByRole("button", {
      name: "Set up HackerAI Desktop for Agent mode",
    });
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveClass(
      "rounded-md",
      "bg-muted",
      "text-foreground",
      "hover:bg-muted/50",
    );
    expect(trigger).not.toHaveClass("border");
    expect(trigger).not.toHaveClass("rounded-full");
    expect(trigger.querySelector("svg")).toHaveClass(
      "size-4",
      "lucide-monitor",
    );
    expect(trigger.querySelectorAll("svg")).toHaveLength(1);
    const label = trigger.querySelector("span");
    expect(label).toHaveTextContent("HackerAI Desktop");
    expect(label).toHaveClass("hidden", "md:inline");
    expect(label).toHaveAttribute("translate", "no");
    expect(label).not.toHaveClass("text-muted-foreground");

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
        name: "Set up HackerAI Desktop for Agent mode",
      }),
    );

    expect(
      screen.getByTestId("free-ask-computer-activation-popover"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        "Use a desktop computer to download HackerAI Desktop for macOS, Windows, or Linux.",
      ),
    ).not.toBeInTheDocument();
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
    expect(download).toHaveTextContent("Download HackerAI Desktop");
    expect(download).not.toHaveClass("hidden");

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
        name: "Set up HackerAI Desktop for Agent mode",
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

  it("replaces the download action with desktop guidance on mobile platforms", async () => {
    mockDetectedPlatform = {
      platform: "ios",
      displayName: "iOS",
      downloadUrl: "",
    };
    const user = userEvent.setup();
    render(<FreeAskComputerActivation />);

    await user.click(
      screen.getByRole("button", {
        name: "Set up HackerAI Desktop for Agent mode",
      }),
    );

    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === "P" &&
          element.textContent ===
            "Use a desktop computer to download HackerAI Desktop for macOS, Windows, or Linux.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("free-ask-computer-download"),
    ).not.toBeInTheDocument();
  });

  it("does not render inside HackerAI Desktop", () => {
    mockIsTauri = true;

    render(<FreeAskComputerActivation />);

    expect(
      screen.queryByRole("button", {
        name: "Set up HackerAI Desktop for Agent mode",
      }),
    ).not.toBeInTheDocument();
    expect(mockCaptureAuthenticatedEvent).not.toHaveBeenCalled();
  });
});
