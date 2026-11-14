import { act, renderHook } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { LOCAL_SANDBOX_PRESENCE_GRACE_MS } from "@/lib/centrifugo/presence";
import { hydrateRoot } from "react-dom/client";
import { afterEach, describe, expect, it, jest } from "@jest/globals";

const mockGlobalState = {
  chatMode: "agent",
  sandboxPreference: "desktop",
  desktopBridgeStatus: "failed",
  localConnections: [{ connectionId: "stale-row", isDesktop: true }] as
    | Array<{
        connectionId: string;
        isDesktop: boolean;
        environmentId?: string;
      }>
    | undefined,
};
let mockHeartbeatsLoading = false;
let mockHeartbeats: Array<{ connectionId: string; lastSeen: number }> = [
  { connectionId: "stale-row", lastSeen: Date.now() },
];
const mockHeartbeatQuery = jest.fn((_query: unknown, args: any) =>
  args === "skip" || mockHeartbeatsLoading
    ? undefined
    : mockHeartbeats.filter((c) => args.connectionIds.includes(c.connectionId)),
);
jest.mock("convex/react", () => ({
  useQuery: (...args: [unknown, any]) => mockHeartbeatQuery(...args),
}));

const mockIsTauriEnvironment = jest.fn(() => true);

jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => mockGlobalState,
}));
jest.mock("../useTauri", () => ({
  isTauriEnvironment: mockIsTauriEnvironment,
}));

const { useSelectedComputerConnection } =
  require("../useSelectedComputerConnection") as typeof import("../useSelectedComputerConnection");

function Probe() {
  const { selectedNativeDesktop, sendDisabledReason } =
    useSelectedComputerConnection();
  return (
    <output>
      {selectedNativeDesktop ? "Native" : "Web"}:{sendDisabledReason}
    </output>
  );
}

describe("selected computer hydration", () => {
  it("does not restore a CLI selection from an untrusted claimed machine ID", () => {
    mockIsTauriEnvironment.mockReturnValue(false);
    mockGlobalState.sandboxPreference = "environment:machine-a";
    mockGlobalState.localConnections = [
      {
        connectionId: "session-one",
        environmentId: "machine-a",
        isDesktop: false,
      },
    ];
    const { result, rerender } = renderHook(useSelectedComputerConnection);
    expect(result.current.selectedComputerUnavailable).toBe(true);
    mockGlobalState.localConnections = [
      {
        connectionId: "other-session",
        environmentId: "machine-b",
        isDesktop: false,
      },
    ];
    rerender();
    expect(result.current.selectedComputerUnavailable).toBe(true);
    mockGlobalState.localConnections = [
      {
        connectionId: "session-two",
        environmentId: "machine-a",
        isDesktop: false,
      },
    ];
    rerender();
    expect(result.current.selectedComputerUnavailable).toBe(true);
    expect(mockGlobalState.sandboxPreference).toBe("environment:machine-a");
  });
  it("expires a disconnected computer without a database update and recovers on its new heartbeat", () => {
    jest.useFakeTimers();
    mockIsTauriEnvironment.mockReturnValue(false);
    mockGlobalState.sandboxPreference = "desktop-environment:machine-a";
    mockGlobalState.localConnections = [
      {
        connectionId: "old",
        environmentId: "machine-a",
        isDesktop: true,
      },
    ];
    mockHeartbeats = [
      {
        connectionId: "old",
        lastSeen: Date.now() - LOCAL_SANDBOX_PRESENCE_GRACE_MS + 1000,
      },
    ];
    const stableDetails = mockGlobalState.localConnections;
    const { result, rerender } = renderHook(useSelectedComputerConnection);
    expect(result.current.selectedComputerUnavailable).toBe(false);
    act(() => jest.advanceTimersByTime(2000));
    expect(result.current.selectedComputerUnavailable).toBe(true);
    expect(result.current.sendDisabledReason).toContain("Reconnect");
    mockHeartbeats = [{ connectionId: "old", lastSeen: Date.now() }];
    rerender();
    expect(mockGlobalState.localConnections).toBe(stableDetails);
    expect(result.current.selectedComputerUnavailable).toBe(false);
    expect(mockGlobalState.sandboxPreference).toBe(
      "desktop-environment:machine-a",
    );
  });

  it("keeps a healthy CLI session available between hourly token refreshes", () => {
    jest.useFakeTimers();
    mockIsTauriEnvironment.mockReturnValue(false);
    mockGlobalState.sandboxPreference = "cli-session";
    mockGlobalState.localConnections = [
      {
        connectionId: "cli-session",
        environmentId: "cli-machine",
        isDesktop: false,
      },
    ];
    const { result } = renderHook(useSelectedComputerConnection);
    act(() => jest.advanceTimersByTime(LOCAL_SANDBOX_PRESENCE_GRACE_MS + 1));
    expect(result.current.selectedComputerUnavailable).toBe(false);
    expect(result.current.sendDisabledReason).toBeUndefined();
  });

  afterEach(() => {
    jest.useRealTimers();
    mockHeartbeats = [{ connectionId: "stale-row", lastSeen: Date.now() }];
    mockHeartbeatsLoading = false;
    mockGlobalState.chatMode = "agent";
    mockGlobalState.sandboxPreference = "desktop";
    mockGlobalState.desktopBridgeStatus = "failed";
    mockGlobalState.localConnections = [
      { connectionId: "stale-row", isDesktop: true },
    ];
    mockIsTauriEnvironment.mockReturnValue(true);
  });

  it("uses the same initial markup, then checks the native bridge after mount", async () => {
    const container = document.createElement("div");
    container.innerHTML = renderToString(<Probe />);
    expect(container.textContent).toBe("Web:");
    const onRecoverableError = jest.fn();
    let root: ReturnType<typeof hydrateRoot>;
    await act(async () => {
      root = hydrateRoot(container, <Probe />, { onRecoverableError });
    });
    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(container.textContent).toBe(
      "Native:Reconnect your computer or choose another environment",
    );
    act(() => root.unmount());
  });

  it("keeps an empty initial remote snapshot pending before showing a disconnect", () => {
    jest.useFakeTimers();
    mockIsTauriEnvironment.mockReturnValue(false);
    mockGlobalState.sandboxPreference = "remote-kali";
    mockGlobalState.localConnections = undefined;

    const { result, rerender } = renderHook(() =>
      useSelectedComputerConnection(),
    );

    expect(result.current.computerConnectionPending).toBe(true);
    expect(result.current.sendDisabledReason).toBe(
      "Checking your computer connection",
    );

    mockGlobalState.localConnections = [];
    rerender();

    act(() => jest.advanceTimersByTime(750));

    expect(result.current.computerConnectionPending).toBe(false);
    expect(result.current.sendDisabledReason).toBe(
      "Reconnect your computer or choose another environment",
    );
  });

  it("does not surface a disconnect when the remote appears during the startup grace", () => {
    jest.useFakeTimers();
    mockIsTauriEnvironment.mockReturnValue(false);
    mockGlobalState.sandboxPreference = "remote-kali";
    mockGlobalState.localConnections = undefined;

    const { result, rerender } = renderHook(() =>
      useSelectedComputerConnection(),
    );
    expect(result.current.computerConnectionPending).toBe(true);

    mockGlobalState.localConnections = [];
    rerender();
    expect(result.current.computerConnectionPending).toBe(true);

    mockGlobalState.localConnections = [
      { connectionId: "remote-kali", isDesktop: false },
    ];
    rerender();

    expect(result.current.computerConnectionPending).toBe(false);
    expect(result.current.selectedComputerUnavailable).toBe(false);
    expect(result.current.sendDisabledReason).toBeUndefined();
    act(() => jest.advanceTimersByTime(750));
    expect(result.current.selectedComputerUnavailable).toBe(false);
  });
});

it("waits for selected heartbeat loading without asking a healthy computer to reconnect", () => {
  mockIsTauriEnvironment.mockReturnValue(false);
  mockGlobalState.sandboxPreference = "desktop";
  mockGlobalState.localConnections = [
    { connectionId: "fresh", isDesktop: true },
  ];
  mockHeartbeats = [{ connectionId: "fresh", lastSeen: Date.now() }];
  mockHeartbeatsLoading = true;
  const { result, rerender } = renderHook(useSelectedComputerConnection);
  expect(result.current.sendDisabledReason).toBe(
    "Checking your computer connection",
  );
  mockHeartbeatsLoading = false;
  rerender();
  expect(result.current.sendDisabledReason).toBeUndefined();
});

it("does not subscribe to heartbeat updates for the native bridge or Cloud", () => {
  mockIsTauriEnvironment.mockReturnValue(true);
  mockGlobalState.sandboxPreference = "desktop";
  const { rerender } = renderHook(useSelectedComputerConnection);
  expect(mockHeartbeatQuery).toHaveBeenLastCalledWith(
    expect.anything(),
    "skip",
  );
  mockGlobalState.sandboxPreference = "e2b";
  rerender();
  expect(mockHeartbeatQuery).toHaveBeenLastCalledWith(
    expect.anything(),
    "skip",
  );
});
