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

    render(<SandboxSelector value="desktop" onChange={onChange} />);

    await waitFor(() => expect(onChange).toHaveBeenCalledWith("remote-kali"));
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
