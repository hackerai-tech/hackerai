import { act, renderHook } from "@testing-library/react";
import { renderToString } from "react-dom/server";
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
  it("restores the selected computer after its relay session changes", () => {
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
    expect(result.current.selectedComputerUnavailable).toBe(false);
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
    expect(result.current.selectedComputerUnavailable).toBe(false);
    expect(mockGlobalState.sandboxPreference).toBe("environment:machine-a");
  });
  afterEach(() => {
    jest.useRealTimers();
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
