import { StrictMode, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("convex/react", () => ({
  useMutation: () => jest.fn(),
}));

const mockIsTauriEnvironment = jest.fn(() => true);

jest.mock("@/app/hooks/useTauri", () => ({
  isTauriEnvironment: mockIsTauriEnvironment,
}));

jest.mock("@/app/services/desktop-sandbox-bridge", () => ({
  DesktopSandboxBridge: jest.fn(),
}));

const mockCaptureAuthenticatedEvent = jest.fn();
jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: mockCaptureAuthenticatedEvent,
}));

jest.mock("sonner", () => ({
  toast: { error: jest.fn() },
}));

const { DesktopSandboxBridge } =
  require("@/app/services/desktop-sandbox-bridge") as typeof import("@/app/services/desktop-sandbox-bridge");
const { useSandboxPreference } =
  require("../useSandboxPreference") as typeof import("../useSandboxPreference");

type BridgeConfig = {
  onTerminated?: (
    reason:
      | "unauthenticated"
      | "connection_not_found"
      | "ownership_mismatch"
      | "connection_inactive"
      | "transport_disconnected",
  ) => void;
  onConnectionState?: (state: "connecting" | "connected") => void;
};

describe("useSandboxPreference", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsTauriEnvironment.mockReturnValue(true);
    window.localStorage.clear();
  });

  it("defaults Desktop to the local sandbox when no preference is saved", () => {
    const { result } = renderHook(() => useSandboxPreference(false));

    expect(result.current.sandboxPreference).toBe("desktop");
  });

  it("defaults the web app to the cloud sandbox when no preference is saved", () => {
    mockIsTauriEnvironment.mockReturnValue(false);

    const { result } = renderHook(() => useSandboxPreference(false));

    expect(result.current.sandboxPreference).toBe("e2b");
  });

  it("preserves an explicit saved cloud preference on Desktop", () => {
    window.localStorage.setItem("sandbox-preference", "e2b");

    const { result } = renderHook(() => useSandboxPreference(false));

    expect(result.current.sandboxPreference).toBe("e2b");
  });

  it("does not initialize the desktop bridge in a web browser", async () => {
    mockIsTauriEnvironment.mockReturnValue(false);

    const { result } = renderHook(() => useSandboxPreference(true));

    await waitFor(() => {
      expect(result.current.desktopBridgeStatus).toBe("idle");
    });
    expect(DesktopSandboxBridge).not.toHaveBeenCalled();
  });

  it("automatically retries a bridge that fails during startup readiness", async () => {
    const bridgeInstances: Array<{
      start: jest.Mock;
      stop: jest.Mock;
      getConnectionId: jest.Mock;
    }> = [];
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    (DesktopSandboxBridge as jest.Mock).mockImplementation(() => {
      const index = bridgeInstances.length;
      const instance = {
        start: jest
          .fn()
          .mockImplementation(() =>
            index === 0
              ? Promise.reject(new Error("transport closed"))
              : Promise.resolve("connection-2"),
          ),
        stop: jest.fn().mockResolvedValue(undefined),
        getConnectionId: jest.fn().mockReturnValue("connection-2"),
      };
      bridgeInstances.push(instance);
      return instance;
    });

    jest.useFakeTimers();
    try {
      const { result, rerender } = renderHook(
        ({ isAuthenticated }) => useSandboxPreference(isAuthenticated),
        { initialProps: { isAuthenticated: true } },
      );

      await act(async () => {
        await jest.advanceTimersByTimeAsync(0);
      });
      expect(bridgeInstances).toHaveLength(1);
      expect(result.current.desktopBridgeStatus).toBe("connecting");
      expect(mockCaptureAuthenticatedEvent).toHaveBeenCalledWith(
        "desktop_bridge_recovery_scheduled",
        {
          clientSurface: "desktop_bridge",
          reason: "startup_failed",
          attempt: 1,
          delayMs: 1_000,
        },
      );

      await act(async () => {
        await jest.advanceTimersByTimeAsync(1_000);
      });
      expect(bridgeInstances).toHaveLength(2);
      expect(result.current.desktopBridgeStatus).toBe("connected");
      expect(result.current.desktopBridgeActive).toBe(true);

      rerender({ isAuthenticated: false });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(0);
      });
      expect(result.current.desktopBridgeStatus).toBe("idle");
    } finally {
      jest.useRealTimers();
      warnSpy.mockRestore();
    }
  });

  it("invalidates on auth loss and automatically recovers a stale connection", async () => {
    let resolveFirstStart: ((connectionId: string) => void) | undefined;
    const firstStart = new Promise<string>((resolve) => {
      resolveFirstStart = resolve;
    });
    const bridgeConfigs: BridgeConfig[] = [];
    const bridgeInstances: Array<{
      start: jest.Mock;
      stop: jest.Mock;
      getConnectionId: jest.Mock;
    }> = [];

    (DesktopSandboxBridge as jest.Mock).mockImplementation(
      (config: BridgeConfig) => {
        const index = bridgeInstances.length;
        const instance = {
          start: jest
            .fn()
            .mockImplementation(() =>
              index === 0
                ? firstStart
                : Promise.resolve(`connection-${index + 1}`),
            ),
          stop: jest.fn().mockResolvedValue(undefined),
          getConnectionId: jest.fn().mockReturnValue(`connection-${index + 1}`),
        };
        bridgeConfigs.push(config);
        bridgeInstances.push(instance);
        return instance;
      },
    );

    const wrapper = ({ children }: { children: ReactNode }) => (
      <StrictMode>{children}</StrictMode>
    );
    const { result, rerender } = renderHook(
      ({ isAuthenticated }) => useSandboxPreference(isAuthenticated),
      { initialProps: { isAuthenticated: true }, wrapper },
    );

    await waitFor(() => {
      expect(result.current.desktopBridgeStatus).toBe("connecting");
      expect(bridgeInstances).toHaveLength(1);
    });

    rerender({ isAuthenticated: false });
    await waitFor(() => {
      expect(result.current.desktopBridgeStatus).toBe("idle");
      expect(result.current.desktopBridgeActive).toBe(false);
    });

    await act(async () => {
      resolveFirstStart?.("connection-1");
      await firstStart;
    });
    await waitFor(() => {
      expect(bridgeInstances[0].stop).toHaveBeenCalledTimes(1);
    });
    expect(result.current.desktopBridgeStatus).toBe("idle");

    rerender({ isAuthenticated: true });
    await waitFor(() => {
      expect(result.current.desktopBridgeStatus).toBe("connected");
      expect(result.current.desktopBridgeActive).toBe(true);
    });

    jest.useFakeTimers();
    try {
      act(() => {
        bridgeConfigs[1].onTerminated?.("connection_inactive");
      });
      expect(result.current.desktopBridgeStatus).toBe("connecting");
      expect(result.current.desktopBridgeActive).toBe(false);

      await act(async () => {
        await jest.advanceTimersByTimeAsync(1_000);
      });

      expect(bridgeInstances).toHaveLength(3);
      expect(result.current.desktopBridgeStatus).toBe("connected");
      expect(result.current.desktopBridgeActive).toBe(true);
    } finally {
      jest.useRealTimers();
    }

    rerender({ isAuthenticated: false });
    await waitFor(() => {
      expect(result.current.desktopBridgeStatus).toBe("idle");
      expect(result.current.desktopBridgeActive).toBe(false);
      expect(bridgeInstances[2].stop).toHaveBeenCalledTimes(1);
    });
  });

  it("stops automatic recovery after six consecutive failures", async () => {
    const bridgeConfigs: BridgeConfig[] = [];
    const bridgeInstances: Array<{
      start: jest.Mock;
      stop: jest.Mock;
      getConnectionId: jest.Mock;
    }> = [];
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    (DesktopSandboxBridge as jest.Mock).mockImplementation(
      (config: BridgeConfig) => {
        const instance = {
          start: jest
            .fn()
            .mockResolvedValue(`connection-${bridgeInstances.length + 1}`),
          stop: jest.fn().mockResolvedValue(undefined),
          getConnectionId: jest
            .fn()
            .mockReturnValue(`connection-${bridgeInstances.length + 1}`),
        };
        bridgeConfigs.push(config);
        bridgeInstances.push(instance);
        return instance;
      },
    );

    const { result, rerender } = renderHook(
      ({ isAuthenticated }) => useSandboxPreference(isAuthenticated),
      { initialProps: { isAuthenticated: true } },
    );

    await waitFor(() => {
      expect(result.current.desktopBridgeStatus).toBe("connected");
      expect(bridgeInstances).toHaveLength(1);
    });

    jest.useFakeTimers();
    try {
      const delays = [1_000, 3_000, 8_000, 16_000, 16_000, 16_000];
      for (const delay of delays) {
        act(() => {
          bridgeConfigs.at(-1)?.onTerminated?.("connection_inactive");
        });
        expect(result.current.desktopBridgeStatus).toBe("connecting");

        await act(async () => {
          await jest.advanceTimersByTimeAsync(delay);
        });
        expect(result.current.desktopBridgeStatus).toBe("connected");
      }

      expect(bridgeInstances).toHaveLength(7);
      act(() => {
        bridgeConfigs.at(-1)?.onTerminated?.("connection_inactive");
      });

      expect(result.current.desktopBridgeStatus).toBe("failed");
      expect(result.current.desktopBridgeActive).toBe(false);
      await act(async () => {
        await jest.advanceTimersByTimeAsync(60_000);
      });
      expect(bridgeInstances).toHaveLength(7);
      expect(warnSpy).toHaveBeenCalledWith(
        "[DesktopSandboxBridge] Automatic recovery exhausted",
        { reason: "connection_inactive", attempts: 6 },
      );
    } finally {
      jest.useRealTimers();
      warnSpy.mockRestore();
    }

    rerender({ isAuthenticated: false });
    await waitFor(() => {
      expect(result.current.desktopBridgeStatus).toBe("idle");
    });
  });
});
