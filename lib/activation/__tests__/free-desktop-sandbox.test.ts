import { describe, expect, it } from "@jest/globals";
import {
  isFreeDesktopSandboxAvailable,
  resolveFreeDesktopSandboxPreference,
} from "../free-desktop-sandbox";

const remoteConnection = {
  connectionId: "remote-kali",
  isDesktop: false,
};

describe("free desktop sandbox selection", () => {
  it("keeps a healthy explicitly selected remote runner", () => {
    expect(
      resolveFreeDesktopSandboxPreference({
        sandboxPreference: "remote-kali",
        desktopBridgeActive: true,
        localConnections: [remoteConnection],
      }),
    ).toBe("remote-kali");
  });

  it("keeps the selected Desktop when its bridge is unavailable", () => {
    expect(
      resolveFreeDesktopSandboxPreference({
        sandboxPreference: "desktop",
        desktopBridgeActive: false,
        localConnections: [
          { connectionId: "stale-desktop", isDesktop: true },
          remoteConnection,
        ],
      }),
    ).toBe("desktop");
  });

  it("keeps the desktop sentinel while no local runner is available", () => {
    expect(
      resolveFreeDesktopSandboxPreference({
        sandboxPreference: "e2b",
        desktopBridgeActive: false,
        localConnections: [],
      }),
    ).toBe("desktop");
  });

  it("waits for connection discovery before replacing a stored remote runner", () => {
    expect(
      resolveFreeDesktopSandboxPreference({
        sandboxPreference: "remote-kali",
        desktopBridgeActive: false,
        localConnections: undefined,
      }),
    ).toBe("remote-kali");
  });

  it("preserves a missing selected runner even when Desktop is connected", () => {
    expect(
      resolveFreeDesktopSandboxPreference({
        sandboxPreference: "missing-runner",
        desktopBridgeActive: true,
        localConnections: [remoteConnection],
      }),
    ).toBe("missing-runner");
  });

  it("reports either a connected desktop bridge or selected remote runner as available", () => {
    expect(
      isFreeDesktopSandboxAvailable({
        sandboxPreference: "desktop",
        desktopBridgeActive: true,
        localConnections: [],
      }),
    ).toBe(true);
    expect(
      isFreeDesktopSandboxAvailable({
        sandboxPreference: "remote-kali",
        desktopBridgeActive: false,
        localConnections: [remoteConnection],
      }),
    ).toBe(true);
    expect(
      isFreeDesktopSandboxAvailable({
        sandboxPreference: "desktop",
        desktopBridgeActive: false,
        localConnections: [remoteConnection],
      }),
    ).toBe(false);
  });
});
