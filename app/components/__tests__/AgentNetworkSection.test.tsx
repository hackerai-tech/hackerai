import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useAction } from "convex/react";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import { AgentNetworkSection } from "../AgentNetworkSection";

jest.mock("convex/react", () => ({ useAction: jest.fn() }));
jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: jest.fn(),
}));
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

const savedConfig = {
  inboundMode: "token_required" as const,
  outboundMode: "allow_only" as const,
  destinations: ["api.example.com", "203.0.113.0/24"],
  updatedAt: 123,
};

describe("AgentNetworkSection", () => {
  const getConfig = jest.fn().mockResolvedValue(savedConfig);
  const saveConfig = jest.fn().mockResolvedValue(savedConfig);

  beforeEach(() => {
    jest.clearAllMocks();
    let hookIndex = 0;
    (useAction as jest.Mock).mockImplementation(
      () => [getConfig, saveConfig][hookIndex++ % 2],
    );
  });

  it("loads saved controls and explains E2B's actual boundaries", async () => {
    render(<AgentNetworkSection />);

    expect(screen.getByText("Loading network controls…")).toBeInTheDocument();
    expect(await screen.findByDisplayValue(/api\.example\.com/)).toBeVisible();
    expect(screen.getByLabelText("Inbound access")).toHaveTextContent(
      "Token required",
    );
    expect(screen.getByText(/Local and desktop environments/)).toBeVisible();

    await userEvent.click(
      screen.getByRole("button", { name: "How filtering works" }),
    );
    expect(screen.getByText(/do not change the sandbox exit IP/)).toBeVisible();
    expect(screen.getByText(/idle sandbox state is preserved/)).toBeVisible();
  });

  it("saves destinations without sending their values to analytics", async () => {
    const user = userEvent.setup();
    render(<AgentNetworkSection />);

    const destinations = await screen.findByLabelText("Allowed destinations");
    await user.clear(destinations);
    await user.type(destinations, "API.Example.com{enter}198.51.100.0/24");
    await user.click(
      screen.getByRole("button", { name: "Save network controls" }),
    );

    await waitFor(() => expect(saveConfig).toHaveBeenCalledTimes(1));
    expect(saveConfig).toHaveBeenCalledWith({
      inboundMode: "token_required",
      outboundMode: "allow_only",
      destinations: ["API.Example.com", "198.51.100.0/24"],
    });
    expect(captureAuthenticatedEvent).toHaveBeenCalledWith(
      "agent_network_settings_saved",
      expect.objectContaining({
        destination_count: 2,
      }),
    );
    const analyticsProperties = (
      captureAuthenticatedEvent as jest.Mock
    ).mock.calls.at(-1)?.[1];
    expect(JSON.stringify(analyticsProperties)).not.toContain("example.com");
    expect(JSON.stringify(analyticsProperties)).not.toContain("198.51.100");
  });

  it("disables every editable control while a save is pending", async () => {
    let resolveSave: (value: typeof savedConfig) => void = () => undefined;
    saveConfig.mockImplementationOnce(
      () =>
        new Promise<typeof savedConfig>((resolve) => {
          resolveSave = resolve;
        }),
    );
    const user = userEvent.setup();
    render(<AgentNetworkSection />);

    const destinations = await screen.findByLabelText("Allowed destinations");
    await user.click(
      screen.getByRole("button", { name: "Save network controls" }),
    );

    expect(destinations).toBeDisabled();
    expect(screen.getByLabelText("Inbound access")).toBeDisabled();
    expect(screen.getByLabelText("Outbound access")).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Save network controls" }),
    ).toBeDisabled();

    resolveSave(savedConfig);
    await waitFor(() => expect(destinations).toBeEnabled());
  });
});
