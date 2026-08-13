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
      | "connection_inactive",
  ) => void;
};

describe("useSandboxPreference", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsTauriEnvironment.mockReturnValue(true);
    window.localStorage.clear();
  });

  it("does not initialize the desktop bridge in a web browser", async () => {
    mockIsTauriEnvironment.mockReturnValue(false);

    const { result } = renderHook(() => useSandboxPreference(true));

    await waitFor(() => {
      expect(result.current.desktopBridgeStatus).toBe("idle");
    });
    expect(DesktopSandboxBridge).not.toHaveBeenCalled();
  });

  it("invalidates bridge startup and connected state when authentication is lost", async () => {
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

    act(() => {
      bridgeConfigs[1].onTerminated?.("connection_inactive");
    });
    await waitFor(() => {
      expect(result.current.desktopBridgeStatus).toBe("failed");
      expect(result.current.desktopBridgeActive).toBe(false);
    });

    act(() => {
      result.current.retryDesktopBridge();
    });
    await waitFor(() => {
      expect(result.current.desktopBridgeStatus).toBe("connected");
      expect(result.current.desktopBridgeActive).toBe(true);
    });

    rerender({ isAuthenticated: false });
    await waitFor(() => {
      expect(result.current.desktopBridgeStatus).toBe("idle");
      expect(result.current.desktopBridgeActive).toBe(false);
      expect(bridgeInstances[2].stop).toHaveBeenCalledTimes(1);
    });
  });
});
