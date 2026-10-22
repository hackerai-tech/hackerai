import { StrictMode, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockResolvedPreferences = new Map<string, string>();
jest.mock("convex/react", () => ({
  useMutation: () => jest.fn(),
  useQuery: (_query: unknown, args: "skip" | { preference: string }) =>
    args === "skip" ? undefined : mockResolvedPreferences.get(args.preference),
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
      | "session_replaced"
      | "connection_inactive"
      | "transport_disconnected",
  ) => void;
  onConnectionState?: (
    state: "connecting" | "connected",
    environmentId?: string,
  ) => void;
};

describe("useSandboxPreference", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsTauriEnvironment.mockReturnValue(true);
    window.localStorage.clear();
    mockResolvedPreferences.clear();
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

  it("persists a remote computer across remounts without falling back to Cloud", () => {
    mockIsTauriEnvironment.mockReturnValue(false);
    const first = renderHook(() => useSandboxPreference(false));
    act(() => first.result.current.setSandboxPreference("remote-kali"));
    first.unmount();
    const second = renderHook(() => useSandboxPreference(false));
    expect(second.result.current.sandboxPreference).toBe("remote-kali");
  });

  it("upgrades an owned legacy session preference and remembers the logical environment", () => {
    mockIsTauriEnvironment.mockReturnValue(false);
    localStorage.setItem("sandbox-preference", "old-session");
    mockResolvedPreferences.set("old-session", "environment:same-computer");
    const first = renderHook(() => useSandboxPreference(true));
    expect(first.result.current.sandboxPreference).toBe(
      "environment:same-computer",
    );
    expect(localStorage.getItem("sandbox-preference")).toBe(
      "environment:same-computer",
    );
    first.unmount();
    const second = renderHook(() => useSandboxPreference(true));
    expect(second.result.current.sandboxPreference).toBe(
      "environment:same-computer",
    );
  });

  it("upgrades a restored task without overwriting the new-task default", () => {
    mockIsTauriEnvironment.mockReturnValue(false);
    localStorage.setItem("sandbox-preference", "environment:default-computer");
    mockResolvedPreferences.set("task-session", "environment:task-computer");
    const { result } = renderHook(() => useSandboxPreference(true));
    act(() =>
      result.current.setSandboxPreference("task-session", { remember: false }),
    );
    expect(result.current.sandboxPreference).toBe("environment:task-computer");
    expect(localStorage.getItem("sandbox-preference")).toBe(
      "environment:default-computer",
    );
    act(() => result.current.resetSandboxPreference());
    expect(result.current.sandboxPreference).toBe(
      "environment:default-computer",
    );
  });

  it("does not let a queued legacy upgrade replace a newer explicit selection", async () => {
    mockIsTauriEnvironment.mockReturnValue(false);
    localStorage.setItem("sandbox-preference", "old-session");
    mockResolvedPreferences.set("old-session", "environment:old-computer");
    const { result } = renderHook(() => useSandboxPreference(true));
    act(() => result.current.setSandboxPreference("environment:new-computer"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.sandboxPreference).toBe("environment:new-computer");
    expect(localStorage.getItem("sandbox-preference")).toBe(
      "environment:new-computer",
    );
  });

  it.each(["desktop", "remote-kali", "e2b"])(
    "restores a task on %s without changing the new-chat default, including after reload",
    (taskPreference) => {
      window.localStorage.setItem("sandbox-preference", "my-default-computer");
      const first = renderHook(() => useSandboxPreference(false));
      act(() =>
        first.result.current.setSandboxPreference(taskPreference, {
          remember: false,
        }),
      );
      expect(first.result.current.sandboxPreference).toBe(taskPreference);
      expect(localStorage.getItem("sandbox-preference")).toBe(
        "my-default-computer",
      );
      act(() => first.result.current.resetSandboxPreference());
      expect(first.result.current.sandboxPreference).toBe(
        "my-default-computer",
      );
      act(() =>
        first.result.current.setSandboxPreference(taskPreference, {
          remember: false,
        }),
      );
      first.unmount();
      const second = renderHook(() => useSandboxPreference(false));
      expect(second.result.current.sandboxPreference).toBe(
        "my-default-computer",
      );
    },
  );

  it("remembers an explicit selection even when it already matches the restored task", () => {
    window.localStorage.setItem("sandbox-preference", "e2b");
    const { result } = renderHook(() => useSandboxPreference(false));
    act(() =>
      result.current.setSandboxPreference("desktop", { remember: false }),
    );
    act(() => result.current.setSandboxPreference("desktop"));
    act(() =>
      result.current.setSandboxPreference("other-task", { remember: false }),
    );
    act(() => result.current.resetSandboxPreference());
    expect(result.current.sandboxPreference).toBe("desktop");
    expect(localStorage.getItem("sandbox-preference")).toBe("desktop");
  });

  it("distinguishes untouched Cloud from an explicit Cloud choice across reloads", () => {
    mockIsTauriEnvironment.mockReturnValue(false);
    const first = renderHook(() => useSandboxPreference(false));
    expect(first.result.current.hasExplicitSandboxPreference).toBe(false);
    act(() => first.result.current.setSandboxPreference("e2b"));
    expect(first.result.current.hasExplicitSandboxPreference).toBe(true);
    first.unmount();
    const second = renderHook(() => useSandboxPreference(false));
    expect(second.result.current.sandboxPreference).toBe("e2b");
    expect(second.result.current.hasExplicitSandboxPreference).toBe(true);
  });

  it("restores legacy Desktop preferences on the web", () => {
    mockIsTauriEnvironment.mockReturnValue(false);
    window.localStorage.setItem("sandbox-preference", "tauri");
    const { result } = renderHook(() => useSandboxPreference(false));
    expect(result.current.sandboxPreference).toBe("desktop");
  });

  it("does not initialize the desktop bridge in a web browser", async () => {
    mockIsTauriEnvironment.mockReturnValue(false);

    const { result } = renderHook(() => useSandboxPreference(true));

    await waitFor(() => {
      expect(result.current.desktopBridgeStatus).toBe("idle");
    });
    expect(DesktopSandboxBridge).not.toHaveBeenCalled();
  });

  it("binds the Desktop default to this installation rather than another online Desktop", async () => {
    (DesktopSandboxBridge as jest.Mock).mockImplementation(() => ({
      start: jest.fn().mockResolvedValue("new-session"),
      stop: jest.fn().mockResolvedValue(undefined),
      getConnectionId: jest.fn().mockReturnValue("new-session"),
      getEnvironmentId: jest.fn().mockReturnValue("this-installation"),
    }));
    const { result, rerender } = renderHook(
      ({ authenticated }) => useSandboxPreference(authenticated),
      { initialProps: { authenticated: true } },
    );
    await waitFor(() =>
      expect(result.current.desktopBridgeStatus).toBe("connected"),
    );
    expect(result.current.sandboxPreference).toBe(
      "desktop-environment:this-installation",
    );
    expect(result.current.desktopEnvironmentId).toBe("this-installation");
    await act(async () => rerender({ authenticated: false }));
  });

  it("recognizes a saved native computer before startup completes, including in StrictMode", async () => {
    localStorage.setItem(
      "sandbox-preference",
      "desktop-environment:this-installation",
    );
    let config!: BridgeConfig;
    let finishStart!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      finishStart = resolve;
    });
    (DesktopSandboxBridge as jest.Mock).mockImplementation(
      (value: BridgeConfig) => {
        config = value;
        return {
          start: jest.fn().mockReturnValue(pending),
          stop: jest.fn().mockResolvedValue(undefined),
          getConnectionId: jest.fn().mockReturnValue(null),
          getEnvironmentId: jest.fn().mockReturnValue("this-installation"),
        };
      },
    );
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StrictMode>{children}</StrictMode>
    );
    const { result, rerender } = renderHook(
      ({ authenticated }) => useSandboxPreference(authenticated),
      { initialProps: { authenticated: true }, wrapper },
    );
    try {
      await waitFor(() => expect(config).toBeDefined());
      act(() => config.onConnectionState?.("connecting", "this-installation"));
      expect(result.current.desktopEnvironmentId).toBe("this-installation");
      expect(result.current.desktopBridgeActive).toBe(false);
      expect(result.current.desktopBridgeStatus).toBe("connecting");
      expect(result.current.sandboxPreference).toBe(
        "desktop-environment:this-installation",
      );
    } finally {
      await act(async () => rerender({ authenticated: false }));
      act(() => config.onConnectionState?.("connecting", "stale-installation"));
      expect(result.current.desktopEnvironmentId).toBeUndefined();
      await act(async () => {
        finishStart("stale-session");
        await pending;
      });
    }
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

  it.each(["manual retry", "fresh sign-in"])(
    "stops unauthorized startup retries until %s",
    async (recovery) => {
      const instances: Array<{ start: jest.Mock; stop: jest.Mock }> = [];
      const unauthorized = Object.assign(new Error("Registration rejected"), {
        data: { code: "UNAUTHORIZED" },
      });
      (DesktopSandboxBridge as jest.Mock).mockImplementation(() => {
        const index = instances.length;
        const instance = {
          start: jest
            .fn()
            .mockImplementation(() =>
              index === 0
                ? Promise.reject(unauthorized)
                : Promise.resolve("new-connection"),
            ),
          stop: jest.fn().mockResolvedValue(undefined),
          getConnectionId: jest
            .fn()
            .mockReturnValue(index === 0 ? null : "new-connection"),
        };
        instances.push(instance);
        return instance;
      });
      const errorSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
      jest.useFakeTimers();
      const { result, rerender } = renderHook(
        ({ authenticated }) => useSandboxPreference(authenticated),
        { initialProps: { authenticated: true } },
      );
      try {
        await act(async () => {
          await jest.advanceTimersByTimeAsync(0);
        });
        expect(result.current.desktopBridgeStatus).toBe("failed");
        expect(result.current.desktopBridgeActive).toBe(false);
        expect(instances[0].stop).toHaveBeenCalledTimes(1);

        await act(async () => {
          await jest.advanceTimersByTimeAsync(120_000);
          window.dispatchEvent(new Event("online"));
          window.dispatchEvent(new Event("focus"));
          document.dispatchEvent(new Event("visibilitychange"));
          await jest.advanceTimersByTimeAsync(120_000);
        });
        expect(instances).toHaveLength(1);
        expect(mockCaptureAuthenticatedEvent).not.toHaveBeenCalledWith(
          "desktop_bridge_recovery_scheduled",
          expect.anything(),
        );
        expect(result.current.desktopBridgeStatus).toBe("failed");

        if (recovery === "manual retry") {
          await act(async () => {
            result.current.retryDesktopBridge();
          });
        } else {
          act(() => rerender({ authenticated: false }));
          await act(async () => {
            await jest.advanceTimersByTimeAsync(0);
          });
          expect(result.current.desktopBridgeStatus).toBe("idle");
          await act(async () => rerender({ authenticated: true }));
        }
        await act(async () => {
          await jest.advanceTimersByTimeAsync(0);
        });
        expect(instances).toHaveLength(2);
        expect(result.current.desktopBridgeStatus).toBe("connected");
        expect(result.current.desktopBridgeActive).toBe(true);
      } finally {
        act(() => rerender({ authenticated: false }));
        await act(async () => {
          await jest.advanceTimersByTimeAsync(0);
        });
        jest.useRealTimers();
        errorSpy.mockRestore();
        warnSpy.mockRestore();
      }
    },
  );

  it.each(["before outage", "during backoff", "during reconnect"])(
    "recovers on the current mount after remounting %s",
    async (timing) => {
      const configs: BridgeConfig[] = [];
      (DesktopSandboxBridge as jest.Mock).mockImplementation(
        (config: BridgeConfig) => {
          configs.push(config);
          let connected = true;
          const terminate = config.onTerminated;
          config.onTerminated = (reason) => {
            connected = false;
            terminate?.(reason);
          };
          return {
            start: jest.fn().mockResolvedValue("connection"),
            stop: jest.fn().mockResolvedValue(undefined),
            getConnectionId: () => (connected ? "connection" : null),
            getEnvironmentId: () => "this-computer",
          };
        },
      );
      const first = renderHook(
        ({ authenticated }) => useSandboxPreference(authenticated),
        { initialProps: { authenticated: true } },
      );
      await waitFor(() =>
        expect(first.result.current.desktopBridgeStatus).toBe("connected"),
      );
      jest.useFakeTimers();
      let second:
        | ReturnType<
            typeof renderHook<
              ReturnType<typeof useSandboxPreference>,
              { authenticated: boolean }
            >
          >
        | undefined;
      try {
        if (timing === "during backoff") {
          act(() => configs[0].onTerminated?.("transport_disconnected"));
        } else if (timing === "during reconnect") {
          act(() => configs[0].onConnectionState?.("connecting"));
        }
        first.unmount();
        second = renderHook(
          ({ authenticated }) => useSandboxPreference(authenticated),
          { initialProps: { authenticated: true } },
        );
        await act(async () => {
          await jest.advanceTimersByTimeAsync(0);
        });
        if (timing !== "before outage") {
          expect(second.result.current.desktopBridgeStatus).toBe("connecting");
          expect(second.result.current.desktopBridgeActive).toBe(false);
          expect(configs).toHaveLength(1);
        }
        if (timing !== "during backoff") {
          act(() => configs[0].onTerminated?.("transport_disconnected"));
        }
        expect(second.result.current.desktopBridgeStatus).toBe("connecting");
        await act(async () => {
          await jest.advanceTimersByTimeAsync(1_000);
        });
        expect(configs).toHaveLength(2);
        expect(second.result.current.desktopBridgeStatus).toBe("connected");
        expect(second.result.current.desktopBridgeActive).toBe(true);
      } finally {
        second?.rerender({ authenticated: false });
        second?.unmount();
        first.unmount();
        jest.useRealTimers();
      }
    },
  );

  it("keeps live reconnect callbacks valid when Retry is clicked", async () => {
    let config!: BridgeConfig;
    (DesktopSandboxBridge as jest.Mock).mockImplementation(
      (value: BridgeConfig) => {
        config = value;
        return {
          start: jest.fn().mockResolvedValue("connection"),
          stop: jest.fn().mockResolvedValue(undefined),
          getConnectionId: () => "connection",
        };
      },
    );
    const mounted = renderHook(
      ({ authenticated }) => useSandboxPreference(authenticated),
      {
        initialProps: { authenticated: true },
      },
    );
    try {
      await waitFor(() =>
        expect(mounted.result.current.desktopBridgeStatus).toBe("connected"),
      );
      act(() => config.onConnectionState?.("connecting"));
      act(() => mounted.result.current.retryDesktopBridge());
      act(() => config.onConnectionState?.("connected"));
      expect(mounted.result.current.desktopBridgeStatus).toBe("connected");
      expect(mounted.result.current.desktopBridgeActive).toBe(true);
      expect(DesktopSandboxBridge).toHaveBeenCalledTimes(1);
    } finally {
      mounted.rerender({ authenticated: false });
      mounted.unmount();
    }
  });

  it("preserves a terminal failure across remounts until an explicit retry", async () => {
    const configs: BridgeConfig[] = [];
    (DesktopSandboxBridge as jest.Mock).mockImplementation(
      (config: BridgeConfig) => {
        configs.push(config);
        return {
          start: jest.fn().mockResolvedValue("connection"),
          stop: jest.fn().mockResolvedValue(undefined),
          getConnectionId: () => "connection",
        };
      },
    );
    const first = renderHook(() => useSandboxPreference(true));
    await waitFor(() =>
      expect(first.result.current.desktopBridgeStatus).toBe("connected"),
    );
    act(() => configs[0].onTerminated?.("session_replaced"));
    first.unmount();
    const second = renderHook(
      ({ authenticated }) => useSandboxPreference(authenticated),
      { initialProps: { authenticated: true } },
    );
    try {
      await waitFor(() =>
        expect(second.result.current.desktopBridgeStatus).toBe("failed"),
      );
      expect(configs).toHaveLength(1);
      act(() => second.result.current.retryDesktopBridge());
      await waitFor(() =>
        expect(second.result.current.desktopBridgeStatus).toBe("connected"),
      );
      expect(configs).toHaveLength(2);
      act(() => window.dispatchEvent(new Event("beforeunload")));
      expect(
        (DesktopSandboxBridge as jest.Mock).mock.results[1].value.stop,
      ).toHaveBeenCalledTimes(1);
    } finally {
      second.rerender({ authenticated: false });
      second.unmount();
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

  it.each(["online", "focus", "visibilitychange"])(
    "resumes exhausted transient recovery on %s without duplicate starts",
    async (resumeEvent) => {
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
        // A socket that drops before a full minute is not a stable recovery.
        // Its old reset timer must not replenish the finite retry budget.
        act(() => bridgeConfigs.at(-1)?.onConnectionState?.("connected"));
        await act(async () => {
          await jest.advanceTimersByTimeAsync(50_000);
        });
        act(() => bridgeConfigs.at(-1)?.onConnectionState?.("connecting"));
        await act(async () => {
          await jest.advanceTimersByTimeAsync(10_000);
        });
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

        const visibilitySpy = jest
          .spyOn(document, "visibilityState", "get")
          .mockReturnValue("hidden");
        try {
          act(() => {
            document.dispatchEvent(new Event("visibilitychange"));
            window.dispatchEvent(new Event("focus"));
          });
          expect(result.current.desktopBridgeStatus).toBe("failed");
          if (resumeEvent !== "online")
            visibilitySpy.mockReturnValue("visible");
          await act(async () => {
            const target =
              resumeEvent === "visibilitychange" ? document : window;
            target.dispatchEvent(new Event(resumeEvent));
            target.dispatchEvent(new Event(resumeEvent));
            window.dispatchEvent(new Event("online"));
          });
          expect(bridgeInstances).toHaveLength(8);
          expect(result.current.desktopBridgeStatus).toBe("connected");
          expect(result.current.desktopBridgeActive).toBe(true);

          act(() => {
            bridgeConfigs
              .at(-1)
              ?.onTerminated?.(
                resumeEvent === "focus"
                  ? "unauthenticated"
                  : resumeEvent === "online"
                    ? "session_replaced"
                    : "ownership_mismatch",
              );
          });
          await act(async () => {
            window.dispatchEvent(new Event("online"));
            window.dispatchEvent(new Event("focus"));
            document.dispatchEvent(new Event("visibilitychange"));
            await jest.advanceTimersByTimeAsync(60_000);
          });
          expect(bridgeInstances).toHaveLength(8);
          expect(result.current.desktopBridgeStatus).toBe("failed");
        } finally {
          visibilitySpy.mockRestore();
        }
      } finally {
        jest.useRealTimers();
        warnSpy.mockRestore();
      }

      rerender({ isAuthenticated: false });
      await waitFor(() => {
        expect(result.current.desktopBridgeStatus).toBe("idle");
      });
    },
  );
});
