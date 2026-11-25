import { Component, StrictMode, Suspense, type ReactNode } from "react";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { DesktopFileBridgeError } from "@/lib/centrifugo/desktop-file-errors";
import {
  publishConvexAuthProviderState,
  type ConvexAuthProviderState,
} from "@/lib/auth/convex-auth-diagnostics";

const mockResolvedPreferences = new Map<string, string>();
type ConvexAuthState = { isLoading: boolean; isAuthenticated: boolean };
const signedInConvexAuth = (): ConvexAuthState => ({
  isLoading: false,
  isAuthenticated: true,
});
let mockConvexAuth = signedInConvexAuth;
jest.mock("convex/react", () => ({
  useMutation: () => jest.fn(),
  useQuery: (_query: unknown, args: "skip" | { preference: string }) =>
    args === "skip" ? undefined : mockResolvedPreferences.get(args.preference),
  useConvexAuth: () => mockConvexAuth(),
}));

const mockIsTauriEnvironment = jest.fn(() => true);
const mockOpenInBrowser = jest
  .fn<() => Promise<boolean>>()
  .mockResolvedValue(true);

jest.mock("@/app/hooks/useTauri", () => ({
  isTauriEnvironment: mockIsTauriEnvironment,
  DESKTOP_UPDATE_URL:
    "https://github.com/hackerai-tech/hackerai/releases/latest",
  openInBrowser: mockOpenInBrowser,
}));

jest.mock("@/app/services/desktop-sandbox-bridge", () => ({
  DesktopSandboxBridge: jest.fn(),
}));

const mockCaptureAuthenticatedEvent = jest.fn();
jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: mockCaptureAuthenticatedEvent,
  subscribeAuthenticatedAnalytics: jest.fn(() => jest.fn()),
}));

jest.mock("sonner", () => ({
  toast: { error: jest.fn() },
}));
const { toast } = require("sonner") as typeof import("sonner");

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
  readNativeAuthFrontendState?: () => unknown;
  readNativeAuthProviderState?: () => unknown;
};

describe("useSandboxPreference", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsTauriEnvironment.mockReturnValue(true);
    window.localStorage.clear();
    mockResolvedPreferences.clear();
    mockConvexAuth = signedInConvexAuth;
  });

  describe("native auth frontend state for bridge diagnostics", () => {
    let configs: BridgeConfig[];
    const readState = () => configs[0]?.readNativeAuthFrontendState?.();
    const setConvexAuth = (isLoading: boolean, isAuthenticated: boolean) => {
      mockConvexAuth = () => ({ isLoading, isAuthenticated });
    };
    const mountConsumer = (
      wrapper?: (props: { children: ReactNode }) => ReactNode,
    ) =>
      renderHook(({ authenticated }) => useSandboxPreference(authenticated), {
        initialProps: { authenticated: true },
        wrapper,
      });

    beforeEach(() => {
      configs = [];
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
    });

    it("reads the current committed state without restarting the bridge", async () => {
      const view = mountConsumer(({ children }) => (
        <StrictMode>{children}</StrictMode>
      ));
      try {
        await waitFor(() =>
          expect(view.result.current.desktopBridgeStatus).toBe("connected"),
        );
        expect(readState()).toBe("owner_present_convex_authenticated");
        setConvexAuth(true, false);
        view.rerender({ authenticated: true });
        expect(readState()).toBe("owner_present_convex_loading");
        setConvexAuth(false, false);
        view.rerender({ authenticated: true });
        expect(readState()).toBe("owner_present_convex_unauthenticated");
        setConvexAuth(false, true);
        view.rerender({ authenticated: true });
        expect(readState()).toBe("owner_present_convex_authenticated");
        expect(DesktopSandboxBridge).toHaveBeenCalledTimes(1);
        expect(view.result.current.desktopBridgeStatus).toBe("connected");

        await act(async () => view.rerender({ authenticated: false }));
        expect(readState()).toBe("owner_absent");
      } finally {
        await act(async () => view.rerender({ authenticated: false }));
        view.unmount();
      }
      expect(readState()).toBe("unavailable");
    });

    it("reads the remounted consumer, not the bridge creator", async () => {
      const first = mountConsumer();
      await waitFor(() =>
        expect(first.result.current.desktopBridgeStatus).toBe("connected"),
      );
      first.unmount();
      expect(readState()).toBe("unavailable");

      setConvexAuth(true, false);
      const second = mountConsumer();
      try {
        await waitFor(() =>
          expect(second.result.current.desktopBridgeStatus).toBe("connected"),
        );
        expect(configs).toHaveLength(1);
        expect(readState()).toBe("owner_present_convex_loading");
      } finally {
        await act(async () => second.rerender({ authenticated: false }));
        second.unmount();
      }
    });

    it("does not let an older consumer's cleanup clear a newer consumer", async () => {
      const older = mountConsumer();
      await waitFor(() =>
        expect(older.result.current.desktopBridgeStatus).toBe("connected"),
      );
      setConvexAuth(false, false);
      const newer = mountConsumer();
      try {
        expect(readState()).toBe("owner_present_convex_unauthenticated");
        older.unmount();
        expect(readState()).toBe("owner_present_convex_unauthenticated");
      } finally {
        await act(async () => newer.rerender({ authenticated: false }));
        newer.unmount();
        older.unmount();
      }
      expect(readState()).toBe("unavailable");
    });

    it.each(["suspended", "abandoned"])(
      "does not publish a %s render",
      async (interruption) => {
        class Boundary extends Component<
          { children: ReactNode },
          { failed: boolean }
        > {
          state = { failed: false };
          static getDerivedStateFromError() {
            return { failed: true };
          }
          render() {
            return this.state.failed ? null : this.props.children;
          }
        }
        const never = new Promise<never>(() => {});
        function Interrupted(): ReactNode {
          useSandboxPreference(false);
          if (interruption === "suspended") throw never;
          throw new Error("render abandoned");
        }
        const error = jest.spyOn(console, "error").mockImplementation(() => {});
        const committed = mountConsumer();
        try {
          await waitFor(() =>
            expect(committed.result.current.desktopBridgeStatus).toBe(
              "connected",
            ),
          );
          setConvexAuth(false, false);
          const interrupted = render(
            <Boundary>
              <Suspense fallback={null}>
                <Interrupted />
              </Suspense>
            </Boundary>,
          );
          expect(readState()).toBe("owner_present_convex_authenticated");
          expect(committed.result.current.desktopBridgeStatus).toBe(
            "connected",
          );
          interrupted.unmount();
          expect(readState()).toBe("owner_present_convex_authenticated");
        } finally {
          await act(async () => committed.rerender({ authenticated: false }));
          committed.unmount();
          error.mockRestore();
        }
      },
    );

    it("reads the committed Convex auth provider state", async () => {
      const { useAuthFromAuthKit } =
        require("@/lib/auth/use-auth-from-authkit") as typeof import("@/lib/auth/use-auth-from-authkit");
      const { CrossTabMutex } =
        require("@/lib/auth/cross-tab-mutex") as typeof import("@/lib/auth/cross-tab-mutex");
      const readProviderState = () =>
        configs[0]?.readNativeAuthProviderState?.();
      let authKitLoading = true;
      const deps = {
        useAuth: () => ({
          user: { id: "user-1" },
          loading: authKitLoading,
          refreshAuth: jest.fn(),
        }),
        useAccessToken: () => ({
          accessToken: "token",
          getAccessToken: jest.fn(),
          refresh: jest.fn(),
        }),
        mutex: new CrossTabMutex(),
        isCrossTabEnabled: () => false,
      } as unknown as Parameters<typeof useAuthFromAuthKit>[0];
      const consumer = mountConsumer();
      try {
        await waitFor(() =>
          expect(consumer.result.current.desktopBridgeStatus).toBe("connected"),
        );
        expect(readProviderState()).toBe("unavailable");
        // The bridge reads the provider committed after it was created.
        const provider = renderHook(() => useAuthFromAuthKit(deps));
        expect(readProviderState()).toBe("authkit_loading");
        authKitLoading = false;
        provider.rerender();
        expect(readProviderState()).toBe("ready");
        provider.unmount();
        expect(readProviderState()).toBe("unavailable");
        expect(DesktopSandboxBridge).toHaveBeenCalledTimes(1);
      } finally {
        await act(async () => consumer.rerender({ authenticated: false }));
        consumer.unmount();
      }
    });
  });

  describe("registration auth wait during token recovery", () => {
    type GateConfig = BridgeConfig & {
      registrationAuthGate?: (signal: AbortSignal) => true | Promise<void>;
    };
    let configs: GateConfig[];
    // The committed frontend state each registration was sent under.
    let registrations: unknown[];
    let clearProviderState: (() => void) | undefined;
    const setProviderState = (state: ConvexAuthProviderState) => {
      clearProviderState?.();
      clearProviderState = publishConvexAuthProviderState(state);
    };
    let convexAuth: ConvexAuthState;
    const setConvexAuth = (isLoading: boolean, isAuthenticated: boolean) => {
      convexAuth = { isLoading, isAuthenticated };
    };
    type Props = { authenticated: boolean; ownerId?: string };
    const mountConsumer = () =>
      renderHook(
        ({ authenticated, ownerId }: Props) =>
          useSandboxPreference(authenticated, ownerId),
        { initialProps: { authenticated: true, ownerId: "user-a" } as Props },
      );
    const flush = () => act(async () => {});

    // Mirrors the bridge's registration contract, which its own suite covers:
    // publish local identity, ask the gate, await each wake, register on true.
    const startThroughGate = async (
      config: GateConfig,
      signal: AbortSignal,
    ) => {
      config.onConnectionState?.("connecting", "native-environment");
      const gate = config.registrationAuthGate ?? (() => true as const);
      for (let ready = gate(signal); ready !== true; ready = gate(signal)) {
        await ready;
        if (signal.aborted) throw new Error("stopped during startup");
      }
      registrations.push(config.readNativeAuthFrontendState?.());
    };

    beforeEach(() => {
      configs = [];
      registrations = [];
      setConvexAuth(true, false);
      mockConvexAuth = () => convexAuth;
      setProviderState("token_recovery");
      (DesktopSandboxBridge as jest.Mock).mockImplementation(
        (config: GateConfig) => {
          configs.push(config);
          const stopped = new AbortController();
          let connectionId: string | null = null;
          return {
            start: jest.fn(async () => {
              await startThroughGate(config, stopped.signal);
              connectionId = "connection";
              return connectionId;
            }),
            stop: jest.fn(async () => {
              stopped.abort();
              connectionId = null;
            }),
            getConnectionId: () => connectionId,
            getEnvironmentId: () => "native-environment",
          };
        },
      );
    });

    afterEach(() => {
      clearProviderState?.();
      clearProviderState = undefined;
    });

    const signOut = async (view: ReturnType<typeof mountConsumer>) => {
      await act(async () => view.rerender({ authenticated: false }));
      view.unmount();
    };

    it("registers once, only after Convex acknowledges the recovered session", async () => {
      const view = mountConsumer();
      try {
        // Local identity is published while backend registration waits.
        await waitFor(() =>
          expect(view.result.current.desktopEnvironmentId).toBe(
            "native-environment",
          ),
        );
        expect(view.result.current.desktopBridgeStatus).toBe("connecting");
        expect(registrations).toEqual([]);

        // The provider can finish recovery before the backend acknowledges.
        setProviderState("ready");
        view.rerender({ authenticated: true, ownerId: "user-a" });
        await flush();
        expect(registrations).toEqual([]);

        setConvexAuth(false, true);
        view.rerender({ authenticated: true, ownerId: "user-a" });
        await waitFor(() =>
          expect(view.result.current.desktopBridgeStatus).toBe("connected"),
        );
        expect(registrations).toEqual(["owner_present_convex_authenticated"]);
        expect(DesktopSandboxBridge).toHaveBeenCalledTimes(1);
        expect(toast.error).not.toHaveBeenCalled();
      } finally {
        await signOut(view);
      }
    });

    it("lets a terminal unauthenticated result register into its existing rejection path", async () => {
      setProviderState("authkit_loading_and_token_recovery");
      const view = mountConsumer();
      try {
        await waitFor(() => expect(configs).toHaveLength(1));
        await flush();
        expect(registrations).toEqual([]);
        setProviderState("ready");
        setConvexAuth(false, false);
        view.rerender({ authenticated: true, ownerId: "user-a" });
        await waitFor(() =>
          expect(registrations).toEqual([
            "owner_present_convex_unauthenticated",
          ]),
        );
      } finally {
        await signOut(view);
      }
    });

    it.each<[ConvexAuthProviderState | "uncommitted", boolean]>([
      ["ready", false],
      ["authkit_loading", true],
      ["uncommitted", true],
    ])(
      "does not wait outside token recovery (provider %s, Convex loading %s)",
      async (providerState, convexLoading) => {
        if (providerState === "uncommitted") {
          clearProviderState?.();
          clearProviderState = undefined;
        } else {
          setProviderState(providerState);
        }
        setConvexAuth(convexLoading, !convexLoading);
        const view = mountConsumer();
        try {
          await waitFor(() =>
            expect(view.result.current.desktopBridgeStatus).toBe("connected"),
          );
          expect(registrations).toEqual([
            convexLoading
              ? "owner_present_convex_loading"
              : "owner_present_convex_authenticated",
          ]);
        } finally {
          await signOut(view);
        }
      },
    );

    it("asks again at dispatch when auth returns to loading after a wake", async () => {
      (DesktopSandboxBridge as jest.Mock).mockImplementation(
        (config: GateConfig) => {
          configs.push(config);
          return {
            start: jest.fn(() => new Promise(() => {})),
            stop: jest.fn().mockResolvedValue(undefined),
            getConnectionId: () => null,
          };
        },
      );
      const view = mountConsumer();
      try {
        await waitFor(() => expect(configs).toHaveLength(1));
        const gate = configs[0].registrationAuthGate!;
        const signal = new AbortController().signal;
        const woken = gate(signal);
        expect(woken).toBeInstanceOf(Promise);

        setConvexAuth(false, true);
        view.rerender({ authenticated: true, ownerId: "user-a" });
        setConvexAuth(true, false);
        view.rerender({ authenticated: true, ownerId: "user-a" });
        await woken;
        // The wake no longer reflects the committed state.
        const again = gate(signal);
        expect(again).toBeInstanceOf(Promise);

        setConvexAuth(false, true);
        view.rerender({ authenticated: true, ownerId: "user-a" });
        await again;
        expect(gate(signal)).toBe(true);
      } finally {
        await signOut(view);
      }
    });

    it("settles an aborted wait without a later auth commit", async () => {
      (DesktopSandboxBridge as jest.Mock).mockImplementation(
        (config: GateConfig) => {
          configs.push(config);
          return {
            start: jest.fn(() => new Promise(() => {})),
            stop: jest.fn().mockResolvedValue(undefined),
            getConnectionId: () => null,
          };
        },
      );
      const view = mountConsumer();
      try {
        await waitFor(() => expect(configs).toHaveLength(1));
        const controller = new AbortController();
        const woken = configs[0].registrationAuthGate!(controller.signal);
        controller.abort();
        await expect(woken).resolves.toBeUndefined();
        expect(() =>
          configs[0].registrationAuthGate!(controller.signal),
        ).toThrow("stopped during startup");
      } finally {
        await signOut(view);
      }
    });

    it("cancels a waiting registration at sign-out without sending it under the next session", async () => {
      const view = mountConsumer();
      await waitFor(() => expect(configs).toHaveLength(1));
      await act(async () =>
        view.rerender({ authenticated: false, ownerId: undefined }),
      );
      expect(view.result.current.desktopBridgeStatus).toBe("idle");

      setProviderState("ready");
      setConvexAuth(false, true);
      view.rerender({ authenticated: true, ownerId: "user-a" });
      try {
        await waitFor(() =>
          expect(view.result.current.desktopBridgeStatus).toBe("connected"),
        );
        expect(configs).toHaveLength(2);
        // Only the new session's start registered.
        expect(registrations).toEqual(["owner_present_convex_authenticated"]);
        expect(toast.error).not.toHaveBeenCalled();
      } finally {
        await signOut(view);
      }
    });

    it("replaces a waiting start on Retry without reporting it failed", async () => {
      const view = mountConsumer();
      try {
        await waitFor(() => expect(configs).toHaveLength(1));
        act(() => view.result.current.retryDesktopBridge());
        await waitFor(() => expect(configs).toHaveLength(2));
        await flush();
        expect(view.result.current.desktopBridgeStatus).toBe("connecting");
        expect(registrations).toEqual([]);

        setProviderState("ready");
        setConvexAuth(false, true);
        view.rerender({ authenticated: true, ownerId: "user-a" });
        await waitFor(() =>
          expect(view.result.current.desktopBridgeStatus).toBe("connected"),
        );
        expect(registrations).toEqual(["owner_present_convex_authenticated"]);
        expect(toast.error).not.toHaveBeenCalled();
      } finally {
        await signOut(view);
      }
    });

    it("fences an older start when the account changes before its first gate check", async () => {
      setProviderState("ready");
      setConvexAuth(false, true);
      let finishFirstProbe!: () => void;
      const firstProbe = new Promise<void>((resolve) => {
        finishFirstProbe = resolve;
      });
      (DesktopSandboxBridge as jest.Mock).mockImplementation(
        (config: GateConfig) => {
          const firstStart = configs.length === 0;
          configs.push(config);
          const stopped = new AbortController();
          return {
            start: jest.fn(async () => {
              if (firstStart) await firstProbe;
              await startThroughGate(config, stopped.signal);
            }),
            stop: jest.fn(async () => stopped.abort()),
            getConnectionId: () => null,
            getEnvironmentId: () => "native-environment",
          };
        },
      );
      const view = mountConsumer();
      try {
        await waitFor(() => expect(configs).toHaveLength(1));
        view.rerender({ authenticated: true, ownerId: "user-b" });
        await act(async () => finishFirstProbe());
        await waitFor(() => expect(configs).toHaveLength(2));
        expect(registrations).toEqual(["owner_present_convex_authenticated"]);
        expect(toast.error).not.toHaveBeenCalled();
      } finally {
        await signOut(view);
      }
    });

    it("restarts for a replacement account that stays signed in while registration waits", async () => {
      const view = mountConsumer();
      try {
        await waitFor(() => expect(configs).toHaveLength(1));
        view.rerender({ authenticated: true, ownerId: "user-b" });
        await waitFor(() => expect(configs).toHaveLength(2));
        await flush();
        expect(registrations).toEqual([]);
        expect(view.result.current.desktopBridgeStatus).toBe("connecting");

        setProviderState("ready");
        setConvexAuth(false, true);
        view.rerender({ authenticated: true, ownerId: "user-b" });
        await waitFor(() =>
          expect(view.result.current.desktopBridgeStatus).toBe("connected"),
        );
        // The first account's start never registered under the second's auth.
        expect(registrations).toEqual(["owner_present_convex_authenticated"]);
        expect(toast.error).not.toHaveBeenCalled();
      } finally {
        await signOut(view);
      }
    });
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
        expect.objectContaining({
          clientSurface: "desktop_bridge",
          reason: "startup_failed",
          attempt: 1,
          delayMs: 1_000,
        }),
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

  it("pauses startup retries while offline and resumes once on network recovery", async () => {
    const online = jest
      .spyOn(navigator, "onLine", "get")
      .mockReturnValue(false);
    (DesktopSandboxBridge as jest.Mock).mockImplementation(() => ({
      start: jest.fn().mockResolvedValue("online-connection"),
      stop: jest.fn().mockResolvedValue(undefined),
      getConnectionId: jest.fn().mockReturnValue("online-connection"),
    }));
    jest.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ authenticated }) => useSandboxPreference(authenticated),
      { initialProps: { authenticated: true } },
    );
    try {
      await act(async () => {
        await jest.advanceTimersByTimeAsync(120_000);
      });
      expect(DesktopSandboxBridge).not.toHaveBeenCalled();
      expect(mockCaptureAuthenticatedEvent).not.toHaveBeenCalled();
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
        await jest.advanceTimersByTimeAsync(120_000);
      });
      expect(DesktopSandboxBridge).not.toHaveBeenCalled();
      online.mockReturnValue(true);
      await act(async () => {
        window.dispatchEvent(new Event("online"));
        window.dispatchEvent(new Event("online"));
        await jest.advanceTimersByTimeAsync(0);
      });
      expect(DesktopSandboxBridge).toHaveBeenCalledTimes(1);
      expect(result.current.desktopBridgeStatus).toBe("connected");
    } finally {
      act(() => rerender({ authenticated: false }));
      await act(async () => {
        await jest.advanceTimersByTimeAsync(0);
      });
      online.mockRestore();
      jest.useRealTimers();
    }
  });

  it("keeps exhausted retries stopped across remounts and rapid wake events", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    (DesktopSandboxBridge as jest.Mock).mockImplementation(() => ({
      start: jest.fn().mockRejectedValue(new Error("relay unavailable")),
      stop: jest.fn().mockResolvedValue(undefined),
      getConnectionId: jest.fn().mockReturnValue(null),
    }));
    jest.useFakeTimers();
    let view = renderHook(
      ({ authenticated }) => useSandboxPreference(authenticated),
      { initialProps: { authenticated: true } },
    );
    try {
      for (let attempt = 0; attempt < 7; attempt++) {
        await act(async () => {
          await jest.advanceTimersByTimeAsync(
            attempt === 0
              ? 0
              : [1_000, 3_000, 8_000, 16_000, 30_000, 60_000][attempt - 1],
          );
        });
      }
      expect(view.result.current.desktopBridgeStatus).toBe("failed");
      const starts = (DesktopSandboxBridge as jest.Mock).mock.calls.length;
      expect(starts).toBe(7);
      view.unmount();
      view = renderHook(
        ({ authenticated }) => useSandboxPreference(authenticated),
        { initialProps: { authenticated: true } },
      );
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
        window.dispatchEvent(new Event("online"));
        document.dispatchEvent(new Event("visibilitychange"));
        await jest.advanceTimersByTimeAsync(0);
      });
      expect(DesktopSandboxBridge).toHaveBeenCalledTimes(starts);
      expect(view.result.current.desktopBridgeStatus).toBe("failed");
      await act(async () => {
        view.result.current.retryDesktopBridge();
        await jest.advanceTimersByTimeAsync(0);
      });
      expect(DesktopSandboxBridge).toHaveBeenCalledTimes(starts + 1);
    } finally {
      act(() => view.rerender({ authenticated: false }));
      await act(async () => {
        await jest.advanceTimersByTimeAsync(0);
      });
      jest.useRealTimers();
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it("resumes an offline-paused bridge when remounted after the network returned", async () => {
    const online = jest
      .spyOn(navigator, "onLine", "get")
      .mockReturnValue(false);
    (DesktopSandboxBridge as jest.Mock).mockImplementation(() => ({
      start: jest.fn().mockResolvedValue("online-connection"),
      stop: jest.fn().mockResolvedValue(undefined),
      getConnectionId: jest.fn().mockReturnValue("online-connection"),
    }));
    jest.useFakeTimers();
    let view = renderHook(
      ({ authenticated }) => useSandboxPreference(authenticated),
      { initialProps: { authenticated: true } },
    );
    try {
      await act(async () => {
        await jest.advanceTimersByTimeAsync(0);
      });
      expect(DesktopSandboxBridge).not.toHaveBeenCalled();
      view.unmount();
      online.mockReturnValue(true);
      view = renderHook(
        ({ authenticated }) => useSandboxPreference(authenticated),
        { initialProps: { authenticated: true } },
      );
      await act(async () => {
        await jest.advanceTimersByTimeAsync(0);
      });
      expect(DesktopSandboxBridge).toHaveBeenCalledTimes(1);
      expect(view.result.current.desktopBridgeStatus).toBe("connected");
    } finally {
      act(() => view.rerender({ authenticated: false }));
      await act(async () => {
        await jest.advanceTimersByTimeAsync(0);
      });
      online.mockRestore();
      jest.useRealTimers();
    }
  });

  it.each(["brief", "stable"])(
    "only replenishes flapping retry budgets after stable recovery (%s)",
    async (recovery) => {
      const configs: BridgeConfig[] = [];
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      (DesktopSandboxBridge as jest.Mock).mockImplementation(
        (config: BridgeConfig) => {
          configs.push(config);
          return {
            start: jest.fn().mockResolvedValue("flapping-connection"),
            stop: jest.fn().mockResolvedValue(undefined),
            getConnectionId: jest.fn().mockReturnValue("flapping-connection"),
          };
        },
      );
      jest.useFakeTimers();
      const { result, rerender } = renderHook(
        ({ authenticated }) => useSandboxPreference(authenticated),
        { initialProps: { authenticated: true } },
      );
      try {
        await act(async () => {
          await jest.advanceTimersByTimeAsync(0);
        });
        for (const delay of [1_000, 3_000, 8_000, 16_000, 30_000, 60_000]) {
          act(() => configs.at(-1)?.onConnectionState?.("connected"));
          await act(async () => {
            await jest.advanceTimersByTimeAsync(75_000);
          });
          act(() => configs.at(-1)?.onTerminated?.("transport_disconnected"));
          await act(async () => {
            await jest.advanceTimersByTimeAsync(delay);
          });
        }
        if (recovery === "stable") {
          act(() => configs.at(-1)?.onConnectionState?.("connected"));
          await act(async () => {
            await jest.advanceTimersByTimeAsync(5 * 60_000);
          });
        }
        act(() => configs.at(-1)?.onTerminated?.("transport_disconnected"));
        expect(result.current.desktopBridgeStatus).toBe(
          recovery === "stable" ? "connecting" : "failed",
        );
        await act(async () => {
          await jest.advanceTimersByTimeAsync(1_000);
        });
        expect(DesktopSandboxBridge).toHaveBeenCalledTimes(
          recovery === "stable" ? 8 : 7,
        );
      } finally {
        act(() => rerender({ authenticated: false }));
        await act(async () => {
          await jest.advanceTimersByTimeAsync(0);
        });
        jest.useRealTimers();
        warn.mockRestore();
      }
    },
  );

  it.each([
    ["unauthorized", "manual retry"],
    ["unauthorized", "fresh sign-in"],
    ["native ACL", "manual retry"],
    ["native ACL", "fresh sign-in"],
  ])("stops %s startup retries until %s", async (failure, recovery) => {
    const instances: Array<{ start: jest.Mock; stop: jest.Mock }> = [];
    const unauthorized =
      failure === "native ACL"
        ? new DesktopFileBridgeError(
            "native_ipc_denied",
            "Native file access denied",
          )
        : Object.assign(new Error("Registration rejected"), {
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
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
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
      if (failure === "native ACL") {
        expect(toast.error).toHaveBeenCalledWith(
          "HackerAI Desktop can't access files",
          expect.objectContaining({
            action: expect.objectContaining({ label: "Download update" }),
          }),
        );
        const action = (toast.error as jest.Mock).mock.calls[0][1] as {
          action: { onClick: () => void };
        };
        await act(async () => action.action.onClick());
        expect(mockOpenInBrowser).toHaveBeenCalledWith(
          "https://github.com/hackerai-tech/hackerai/releases/latest",
        );
      }

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
  });

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
        const delays = [1_000, 3_000, 8_000, 16_000, 30_000, 60_000];
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
        // A socket that drops before the stability window is not a recovery.
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
