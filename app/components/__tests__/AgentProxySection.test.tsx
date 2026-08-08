import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useAction } from "convex/react";
import { AgentProxySection } from "../AgentProxySection";

jest.mock("convex/react", () => ({ useAction: jest.fn() }));
jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: jest.fn(),
}));
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

const savedConfig = {
  enabled: true,
  protocol: "http" as const,
  host: "proxy.example.com",
  port: 8443,
  username: "alice",
  hasPassword: true,
  proxyDns: true,
  bypassHosts: ["internal.example.com"],
  updatedAt: 1234,
};

describe("AgentProxySection", () => {
  const getProxyConfig = jest.fn().mockResolvedValue(savedConfig);
  const saveProxyConfig = jest.fn().mockResolvedValue(savedConfig);
  const deleteProxyConfig = jest.fn().mockResolvedValue(null);

  beforeEach(() => {
    jest.clearAllMocks();
    let hookIndex = 0;
    (useAction as jest.Mock).mockImplementation(
      () =>
        [getProxyConfig, saveProxyConfig, deleteProxyConfig][hookIndex++ % 3],
    );
  });

  it("loads a masked saved config and explains the traffic boundary", async () => {
    render(<AgentProxySection />);

    expect(screen.getByText("Loading proxy settings…")).toBeInTheDocument();
    expect(await screen.findByDisplayValue("proxy.example.com")).toBeVisible();
    expect(screen.getByPlaceholderText(/Saved securely/)).toHaveValue("");
    expect(
      screen.getByText(/Web Search and URL Reader stay direct/),
    ).toBeVisible();
    expect(screen.queryByText("secret-value")).not.toBeInTheDocument();
  });

  it("keeps a new proxy compact until the user enables and configures it", async () => {
    getProxyConfig.mockResolvedValueOnce(null);
    const user = userEvent.setup();
    render(<AgentProxySection />);

    expect(await screen.findByText("Cloud Agent Proxy")).toBeVisible();
    expect(screen.queryByLabelText("Proxy Server")).not.toBeInTheDocument();

    await user.click(screen.getByLabelText("Enable Cloud Agent proxy"));

    expect(screen.getByLabelText("Proxy Server")).toBeVisible();
    expect(screen.queryByLabelText(/Username/)).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Authentication & Advanced" }),
    );
    expect(screen.getByLabelText(/Username/)).toBeVisible();
  });

  it("saves before testing and displays only the returned exit IP", async () => {
    const user = userEvent.setup();
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ exitIp: "203.0.113.42", durationMs: 412 }),
    });
    global.fetch = fetchMock as typeof fetch;
    render(<AgentProxySection />);

    await screen.findByDisplayValue("proxy.example.com");
    await user.click(screen.getByRole("button", { name: "Save & Test" }));

    await waitFor(() => expect(saveProxyConfig).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith("/api/proxy-config/test", {
      method: "POST",
    });
    expect(
      await screen.findByText(/Connected through 203\.0\.113\.42/),
    ).toBeVisible();
    expect(saveProxyConfig).toHaveBeenCalledWith(
      expect.not.objectContaining({ password: expect.anything() }),
    );
  });

  it("prevents edits while a save is pending", async () => {
    let resolveSave: (config: typeof savedConfig) => void = () => undefined;
    saveProxyConfig.mockImplementationOnce(
      () =>
        new Promise<typeof savedConfig>((resolve) => {
          resolveSave = resolve;
        }),
    );
    const user = userEvent.setup();
    render(<AgentProxySection />);

    const hostInput = await screen.findByLabelText("Proxy Server");
    await user.click(screen.getByRole("button", { name: "Save & Test" }));

    expect(hostInput).toBeDisabled();
    expect(screen.getByLabelText("Enable Cloud Agent proxy")).toBeDisabled();
    expect(screen.getByLabelText("Protocol")).toBeDisabled();
    expect(hostInput).toHaveValue("proxy.example.com");

    resolveSave(savedConfig);
    await waitFor(() => expect(hostInput).toBeEnabled());
    expect(hostInput).toHaveValue("proxy.example.com");
  });

  it("confirms before removing saved proxy credentials", async () => {
    const user = userEvent.setup();
    render(<AgentProxySection />);

    await screen.findByDisplayValue("proxy.example.com");
    await user.click(screen.getByRole("button", { name: "Remove Proxy" }));

    expect(deleteProxyConfig).not.toHaveBeenCalled();
    const dialog = screen.getByRole("alertdialog");
    expect(
      within(dialog).getByText(/deletes the saved proxy address/),
    ).toBeVisible();
    await user.click(
      within(dialog).getByRole("button", { name: "Remove Proxy" }),
    );

    await waitFor(() => expect(deleteProxyConfig).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});
