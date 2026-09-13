import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockCaptureUpgradeCtaImpression = jest.fn();

jest.mock("@/lib/analytics/client", () => ({
  captureUpgradeCtaImpression: (...args: unknown[]) =>
    mockCaptureUpgradeCtaImpression(...args),
}));

jest.mock("@/app/hooks/usePricingDialog", () => ({
  redirectToPricing: jest.fn(),
}));

jest.mock("@/lib/utils/settings-dialog", () => ({
  openSettingsDialog: jest.fn(),
}));

const { AgentUpgradeDialog } =
  require("../AgentUpgradeDialog") as typeof import("../AgentUpgradeDialog");

describe("AgentUpgradeDialog", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("shows Desktop connection progress instead of a download prompt", () => {
    render(
      <AgentUpgradeDialog
        open
        onOpenChange={jest.fn()}
        isDesktopEnvironment
        desktopBridgeStatus="connecting"
        onRetryDesktopBridge={jest.fn()}
        onUseConnectedDesktop={jest.fn()}
      />,
    );

    expect(screen.getByText("Connecting Desktop sandbox")).toBeInTheDocument();
    expect(
      screen.getByText("HackerAI Desktop is connecting its local sandbox."),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("agent-install-desktop-button"),
    ).not.toBeInTheDocument();
  });

  it("retries a failed Desktop sandbox connection", async () => {
    const user = userEvent.setup();
    const onRetryDesktopBridge = jest.fn();

    render(
      <AgentUpgradeDialog
        open
        onOpenChange={jest.fn()}
        isDesktopEnvironment
        desktopBridgeStatus="failed"
        onRetryDesktopBridge={onRetryDesktopBridge}
        onUseConnectedDesktop={jest.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /Retry Desktop connection/ }),
    );

    expect(onRetryDesktopBridge).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByTestId("agent-install-desktop-button"),
    ).not.toBeInTheDocument();
  });

  it("enters Agent mode after the Desktop sandbox connects", async () => {
    const user = userEvent.setup();
    const onUseConnectedDesktop = jest.fn();

    render(
      <AgentUpgradeDialog
        open
        onOpenChange={jest.fn()}
        isDesktopEnvironment
        desktopBridgeStatus="connected"
        onRetryDesktopBridge={jest.fn()}
        onUseConnectedDesktop={onUseConnectedDesktop}
      />,
    );

    await user.click(screen.getByTestId("agent-use-desktop-button"));

    expect(onUseConnectedDesktop).toHaveBeenCalledTimes(1);
  });

  it("keeps the Desktop download option on the web", () => {
    render(
      <AgentUpgradeDialog
        open
        onOpenChange={jest.fn()}
        isDesktopEnvironment={false}
        desktopBridgeStatus="idle"
        onRetryDesktopBridge={jest.fn()}
        onUseConnectedDesktop={jest.fn()}
      />,
    );

    expect(
      screen.getByTestId("agent-install-desktop-button"),
    ).toBeInTheDocument();
  });
});
