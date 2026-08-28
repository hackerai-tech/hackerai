import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockGlobalState = {
  subscription: "free",
  localConnections: [] as Array<{
    connectionId: string;
    isDesktop: boolean;
    name?: string;
    osInfo?: { hostname?: string };
  }>,
  desktopBridgeStatus: "connecting",
};
let mockPresenceConnections: Array<{
  connectionId: string;
  online: boolean;
}> = [];

jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => mockGlobalState,
}));

jest.mock("@/app/hooks/useTauri", () => ({
  useTauri: () => ({ isTauri: true }),
}));

jest.mock("@/app/download/DownloadSection", () => ({
  detectPlatform: () => ({ platform: "linux", downloadUrl: "/download" }),
}));

jest.mock("sonner", () => ({
  toast: { info: jest.fn() },
}));

const { SandboxSelector } =
  require("../SandboxSelector") as typeof import("../SandboxSelector");

describe("SandboxSelector", () => {
  beforeEach(() => {
    mockGlobalState.subscription = "free";
    mockGlobalState.localConnections = [];
    mockGlobalState.desktopBridgeStatus = "connecting";
    mockPresenceConnections = [];
    global.fetch = jest.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ connections: mockPresenceConnections }),
    })) as typeof fetch;
  });

  it("shows Local reconnecting instead of Cloud while Desktop reconnects", () => {
    render(<SandboxSelector value="desktop" />);

    expect(
      screen.getByRole("button", { name: /Local reconnecting/i }),
    ).toBeInTheDocument();
  });

  it("shows Local unavailable instead of Cloud after Desktop recovery fails", () => {
    mockGlobalState.desktopBridgeStatus = "failed";
    mockGlobalState.localConnections = [
      { connectionId: "stale-desktop", isDesktop: true },
    ];

    render(<SandboxSelector value="desktop" />);

    expect(
      screen.getByRole("button", { name: /Local unavailable/i }),
    ).toBeInTheDocument();
  });

  it("shows the selected remote runner when it is connected", () => {
    mockGlobalState.desktopBridgeStatus = "connected";
    mockGlobalState.localConnections = [
      {
        connectionId: "remote-kali",
        isDesktop: false,
        name: "Kali VM",
        osInfo: { hostname: "4p3x" },
      },
    ];

    render(<SandboxSelector value="remote-kali" />);

    expect(screen.getByRole("button", { name: /4p3x/i })).toBeInTheDocument();
  });

  it("caps long remote names in the chat toolbar without losing the full name", () => {
    const hostname = "admin1-HP-EliteDesk-800-G3-SFF-with-a-long-suffix";
    mockGlobalState.desktopBridgeStatus = "connected";
    mockGlobalState.localConnections = [
      {
        connectionId: "remote-office-pc",
        isDesktop: false,
        name: "Office PC",
        osInfo: { hostname },
      },
    ];

    render(<SandboxSelector value="remote-office-pc" size="toolbar" />);

    expect(screen.getByRole("button", { name: hostname })).toHaveClass(
      "max-w-44",
      "min-w-0",
    );
    expect(screen.getByTitle(hostname)).toBeInTheDocument();
    expect(screen.getByText(hostname)).toHaveClass(
      "min-w-0",
      "flex-1",
      "truncate",
    );
  });

  it("selects a healthy remote runner while the embedded bridge reconnects", async () => {
    const onChange = jest.fn();
    mockGlobalState.localConnections = [
      { connectionId: "stale-desktop", isDesktop: true },
      {
        connectionId: "remote-kali",
        isDesktop: false,
        name: "Kali VM",
        osInfo: { hostname: "4p3x" },
      },
    ];
    mockPresenceConnections = [
      { connectionId: "stale-desktop", online: false },
      { connectionId: "remote-kali", online: true },
    ];

    render(<SandboxSelector value="desktop" onChange={onChange} />);

    await waitFor(() => expect(onChange).toHaveBeenCalledWith("remote-kali"));
  });

  it("does not select a remote runner without live relay presence", async () => {
    const onChange = jest.fn();
    mockGlobalState.localConnections = [
      { connectionId: "stale-desktop", isDesktop: true },
      {
        connectionId: "remote-kali",
        isDesktop: false,
        name: "Kali VM",
        osInfo: { hostname: "4p3x" },
      },
    ];
    mockPresenceConnections = [
      { connectionId: "stale-desktop", online: false },
      { connectionId: "remote-kali", online: false },
    ];

    render(<SandboxSelector value="desktop" onChange={onChange} />);

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith("/api/sandbox/presence"),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /4p3x/i }),
      ).not.toBeInTheDocument(),
    );
    expect(onChange).not.toHaveBeenCalledWith("remote-kali");
  });

  it("does not auto-select a reconnecting embedded bridge", async () => {
    const onChange = jest.fn();
    mockGlobalState.localConnections = [
      { connectionId: "stale-desktop", isDesktop: true },
    ];

    render(<SandboxSelector value="e2b" onChange={onChange} />);

    await waitFor(() => expect(onChange).not.toHaveBeenCalled());
  });

  it("continues to prefer a connected embedded bridge", async () => {
    const onChange = jest.fn();
    mockGlobalState.desktopBridgeStatus = "connected";
    mockGlobalState.localConnections = [
      { connectionId: "desktop-connection", isDesktop: true },
      { connectionId: "remote-kali", isDesktop: false, name: "Kali VM" },
    ];

    render(<SandboxSelector value="e2b" onChange={onChange} />);

    await waitFor(() => expect(onChange).toHaveBeenCalledWith("desktop"));
  });
});
