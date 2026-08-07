import { render, screen, waitFor } from "@testing-library/react";
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
      screen.getByText(/Web search and URL-reading tools are not included/),
    ).toBeVisible();
    expect(screen.queryByText("secret-value")).not.toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: "Test connection" }));

    await waitFor(() => expect(saveProxyConfig).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith("/api/proxy-config/test", {
      method: "POST",
    });
    expect(await screen.findByText(/Exit IP 203\.0\.113\.42/)).toBeVisible();
    expect(saveProxyConfig).toHaveBeenCalledWith(
      expect.not.objectContaining({ password: expect.anything() }),
    );
  });
});
