import "@testing-library/jest-dom";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { FreeAgentActivationStatus } from "@/lib/activation/free-agent-activation";

const mockCaptureEvent = jest.fn<
  (event: string, properties: Record<string, unknown>) => boolean
>(() => true);
const mockCaptureQueued = jest.fn<
  (input: { event: string; properties?: Record<string, unknown> }) => boolean
>(() => true);
const mockRedirectToPricing = jest.fn();
const mockOpenSettingsDialog = jest.fn();

jest.mock("@/lib/analytics/client", () => ({
  captureUpgradeCtaImpression: jest.fn(),
  captureAuthenticatedEvent: (
    event: string,
    properties: Record<string, unknown>,
  ) => mockCaptureEvent(event, properties),
  captureQueuedAuthenticatedEvent: (input: {
    event: string;
    properties?: Record<string, unknown>;
  }) => mockCaptureQueued(input),
  getPermittedAnalyticsUserId: () => null,
  subscribeAuthenticatedAnalytics: () => () => {},
}));

jest.mock("@/app/hooks/usePricingDialog", () => ({
  redirectToPricing: (...args: unknown[]) => mockRedirectToPricing(...args),
}));

jest.mock("@/lib/utils/settings-dialog", () => ({
  openSettingsDialog: (...args: unknown[]) => mockOpenSettingsDialog(...args),
}));

jest.mock("@/app/download/DownloadSection", () => ({
  useDetectedPlatform: () => ({
    platform: "macos",
    displayName: "macOS",
    downloadUrl: "https://downloads.example.test/HackerAI.dmg",
  }),
}));

const { FreeAgentGateNotice } = jest.requireActual<
  typeof import("../FreeAgentGateNotice")
>("../FreeAgentGateNotice");

const status: FreeAgentActivationStatus = {
  variant: "test",
  completedAskResponses: 3,
  introLimit: 3,
  requiresAgent: true,
};

const renderNotice = (
  props: Partial<{
    needsComputer: boolean;
    connectedComputerName: string | null;
  }> = {},
) =>
  render(
    <FreeAgentGateNotice
      status={status}
      needsComputer={props.needsComputer ?? true}
      connectedComputerName={props.connectedComputerName ?? null}
    />,
  );

describe("FreeAgentGateNotice", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("offers setup and upgrade once the introductory replies are used", () => {
    renderNotice();

    const notice = screen.getByRole("region", {
      name: "You've used your 3 free Ask replies",
    });
    expect(
      within(notice).getByRole("button", { name: "Continue with Agent" }),
    ).toBeInTheDocument();
    expect(
      within(notice).getByRole("button", { name: "Upgrade" }),
    ).toBeInTheDocument();
    expect(mockCaptureQueued).toHaveBeenCalledWith(
      expect.objectContaining({ event: "free_agent_activation_gate_shown" }),
    );
  });

  it("records the gate only once it is visible in the foreground tab", () => {
    const setVisibility = (state: DocumentVisibilityState) => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => state,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    const gateShownCalls = () =>
      mockCaptureQueued.mock.calls.filter(
        ([input]) => input.event === "free_agent_activation_gate_shown",
      );
    setVisibility("hidden");
    try {
      renderNotice();
      expect(gateShownCalls()).toHaveLength(0);

      act(() => setVisibility("visible"));
      act(() => setVisibility("hidden"));
      act(() => setVisibility("visible"));

      expect(gateShownCalls()).toHaveLength(1);
    } finally {
      setVisibility("visible");
    }
  });

  it("hides the card once a computer is selected", () => {
    renderNotice({ needsComputer: false });

    expect(
      screen.queryByTestId("free-agent-gate-notice"),
    ).not.toBeInTheDocument();
  });

  it("opens setup with Desktop as the primary action and explains local execution", async () => {
    const user = userEvent.setup();
    renderNotice();

    await user.click(
      screen.getByRole("button", { name: "Continue with Agent" }),
    );

    const dialog = screen.getByRole("dialog", { name: "Continue with Agent" });
    expect(
      within(dialog).getByText(
        "Agent runs terminal commands and works with files on the computer you connect.",
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("link", { name: "Download for macOS" }),
    ).toHaveAttribute("href", "https://downloads.example.test/HackerAI.dmg");
    expect(
      within(dialog).getByRole("button", {
        name: /Connect an existing computer/,
      }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: /Upgrade for Cloud Agent/ }),
    ).toBeInTheDocument();
  });

  it("stays open after download and waits for a real connection", async () => {
    const user = userEvent.setup();
    const { rerender } = renderNotice();
    await user.click(
      screen.getByRole("button", { name: "Continue with Agent" }),
    );

    await user.click(screen.getByRole("link", { name: "Download for macOS" }));

    expect(screen.getByRole("status")).toHaveTextContent(
      "Waiting for HackerAI Desktop to connect…",
    );
    expect(mockCaptureEvent).toHaveBeenCalledWith(
      "free_agent_activation_setup_action",
      expect.objectContaining({ action: "download_desktop", variant: "test" }),
    );

    // The selected computer hides the card; setup must still finish visibly.
    rerender(
      <FreeAgentGateNotice
        status={status}
        needsComputer={false}
        connectedComputerName="MacBook Pro"
      />,
    );
    expect(
      screen.getByRole("dialog", { name: "MacBook Pro is connected" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Use Agent" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("returns to the other options while waiting", async () => {
    const user = userEvent.setup();
    renderNotice();
    await user.click(
      screen.getByRole("button", { name: "Continue with Agent" }),
    );
    await user.click(screen.getByRole("link", { name: "Download for macOS" }));

    await user.click(screen.getByRole("button", { name: "Other options" }));

    expect(
      screen.getByRole("button", { name: /Connect an existing computer/ }),
    ).toBeInTheDocument();
  });

  it("opens Remote Control settings to connect an existing computer", async () => {
    const user = userEvent.setup();
    renderNotice();
    await user.click(
      screen.getByRole("button", { name: "Continue with Agent" }),
    );

    await user.click(
      screen.getByRole("button", { name: /Connect an existing computer/ }),
    );

    expect(mockOpenSettingsDialog).toHaveBeenCalledWith("Remote Control");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("routes both upgrade actions to pricing with the gate source", async () => {
    const user = userEvent.setup();
    renderNotice();

    await user.click(screen.getByRole("button", { name: "Upgrade" }));
    await user.click(
      screen.getByRole("button", { name: "Continue with Agent" }),
    );
    await user.click(
      screen.getByRole("button", { name: /Upgrade for Cloud Agent/ }),
    );

    expect(mockRedirectToPricing).toHaveBeenCalledTimes(2);
    for (const [properties] of mockRedirectToPricing.mock.calls) {
      expect(properties).toEqual(
        expect.objectContaining({ source: "free_agent_activation_gate" }),
      );
    }
  });
});
