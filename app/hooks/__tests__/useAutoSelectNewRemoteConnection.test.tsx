import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("sonner", () => ({
  toast: {
    success: jest.fn(),
  },
}));

const { requestRemoteConnectionSelection, useAutoSelectNewRemoteConnection } =
  jest.requireActual<typeof import("../useAutoSelectNewRemoteConnection")>(
    "../useAutoSelectNewRemoteConnection",
  );
const { toast } = jest.requireMock<typeof import("sonner")>("sonner");

const remoteConnection = {
  connectionId: "remote-1",
  isDesktop: false,
};

const desktopConnection = {
  connectionId: "desktop-1",
  isDesktop: true,
};

function makeProps() {
  return {
    connections: [] as Array<{ connectionId: string; isDesktop: boolean }>,
    enabled: true,
    isNewChat: true,
    hasExplicitSandboxPreference: false,
    chatMode: "ask" as const,
    setChatMode: jest.fn(),
    subscription: "free" as const,
    freeSubscriptionResolved: true,
    sandboxPreference: "e2b",
    setSandboxPreference: jest.fn(),
    selectedModel: "hackerai-pro" as const,
    setSelectedModel: jest.fn(),
  };
}

describe("useAutoSelectNewRemoteConnection", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("selects a new remote machine globally and switches free users to Agent", () => {
    const props = makeProps();
    const { rerender } = renderHook(
      (currentProps) => useAutoSelectNewRemoteConnection(currentProps),
      { initialProps: props },
    );

    rerender({ ...props, connections: [remoteConnection] });

    expect(props.setSandboxPreference).toHaveBeenCalledWith("remote-1", {
      remember: false,
    });
    expect(props.setSelectedModel).toHaveBeenCalledWith("auto");
    expect(props.setChatMode).toHaveBeenCalledWith("agent");
    expect(toast.success).toHaveBeenCalledWith(
      "Local machine connected and selected. Switched to Agent mode.",
    );
  });

  it("does not override Cloud with a connection present on initial load", () => {
    const props = makeProps();

    renderHook(() =>
      useAutoSelectNewRemoteConnection({
        ...props,
        connections: [remoteConnection],
      }),
    );

    expect(props.setSandboxPreference).not.toHaveBeenCalled();
    expect(props.setChatMode).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("selects a reconnected runner when the saved connection ID is unavailable", () => {
    const props = {
      ...makeProps(),
      hasExplicitSandboxPreference: true,
      chatMode: "agent" as const,
      sandboxPreference: "expired-connection-id",
    };
    const { rerender } = renderHook(
      (currentProps) => useAutoSelectNewRemoteConnection(currentProps),
      { initialProps: props },
    );

    act(() => requestRemoteConnectionSelection("expired-connection-id"));
    rerender({ ...props, connections: [remoteConnection] });

    expect(props.setSandboxPreference).toHaveBeenCalledWith("remote-1", {
      remember: false,
    });
    expect(props.setChatMode).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith(
      "Local machine connected and selected.",
    );
  });

  it("does not replace an unavailable saved runner without a reconnect request", () => {
    const props = {
      ...makeProps(),
      hasExplicitSandboxPreference: true,
      sandboxPreference: "expired-connection-id",
    };
    const { rerender } = renderHook(
      (currentProps) => useAutoSelectNewRemoteConnection(currentProps),
      { initialProps: props },
    );

    rerender({ ...props, connections: [remoteConnection] });

    expect(props.setSandboxPreference).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it.each([
    {
      sandboxPreference: "remote-existing",
      existingConnection: {
        connectionId: "remote-existing",
        isDesktop: false,
      },
    },
    {
      sandboxPreference: "desktop",
      existingConnection: desktopConnection,
    },
  ])(
    "does not replace connected $sandboxPreference when a different runner appears",
    ({ sandboxPreference, existingConnection }) => {
      const props = {
        ...makeProps(),
        sandboxPreference,
        connections: [existingConnection],
      };
      const { rerender } = renderHook(
        (currentProps) => useAutoSelectNewRemoteConnection(currentProps),
        { initialProps: props },
      );
      rerender({
        ...props,
        connections: [existingConnection, remoteConnection],
      });
      expect(props.setSandboxPreference).not.toHaveBeenCalled();
      expect(props.setChatMode).not.toHaveBeenCalled();
    },
  );

  it.each([
    { isNewChat: true, hasExplicitSandboxPreference: true },
    { isNewChat: false, hasExplicitSandboxPreference: false },
  ])(
    "preserves Cloud and the mode when a runner appears for %j",
    (selection) => {
      const props = { ...makeProps(), ...selection };
      const { rerender } = renderHook(useAutoSelectNewRemoteConnection, {
        initialProps: props,
      });
      rerender({ ...props, connections: [remoteConnection] });
      expect(props.setSandboxPreference).not.toHaveBeenCalled();
      expect(props.setChatMode).not.toHaveBeenCalled();
      expect(props.setSelectedModel).not.toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalled();
    },
  );

  it("honors a Cloud choice made in the same update as a runner arrives", () => {
    const props = makeProps();
    const { rerender } = renderHook(useAutoSelectNewRemoteConnection, {
      initialProps: props,
    });
    rerender({
      ...props,
      hasExplicitSandboxPreference: true,
      connections: [remoteConnection],
    });
    expect(props.setSandboxPreference).not.toHaveBeenCalled();
  });

  it("ignores native Desktop bridge connections", () => {
    const props = makeProps();
    const { rerender } = renderHook(
      (currentProps) => useAutoSelectNewRemoteConnection(currentProps),
      { initialProps: props },
    );

    rerender({ ...props, connections: [desktopConnection] });

    expect(props.setSandboxPreference).not.toHaveBeenCalled();
    expect(props.setChatMode).not.toHaveBeenCalled();
  });

  it("selects the machine without changing an existing paid Agent setup", () => {
    const props = {
      ...makeProps(),
      chatMode: "agent" as const,
      subscription: "pro" as const,
      selectedModel: "hackerai-pro" as const,
    };
    const { rerender } = renderHook(
      (currentProps) => useAutoSelectNewRemoteConnection(currentProps),
      { initialProps: props },
    );

    rerender({ ...props, connections: [remoteConnection] });

    expect(props.setSandboxPreference).toHaveBeenCalledWith("remote-1", {
      remember: false,
    });
    expect(props.setSelectedModel).not.toHaveBeenCalled();
    expect(props.setChatMode).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith(
      "Local machine connected and selected.",
    );
  });

  it("preserves the model while subscription entitlements are unresolved", () => {
    const props = {
      ...makeProps(),
      subscription: "free" as const,
      freeSubscriptionResolved: false,
      selectedModel: "hackerai-pro" as const,
    };
    const { rerender } = renderHook(
      (currentProps) => useAutoSelectNewRemoteConnection(currentProps),
      { initialProps: props },
    );

    rerender({ ...props, connections: [remoteConnection] });

    expect(props.setSandboxPreference).toHaveBeenCalledWith("remote-1", {
      remember: false,
    });
    expect(props.setSelectedModel).not.toHaveBeenCalled();
    expect(props.setChatMode).toHaveBeenCalledWith("agent");
  });

  it("resets its baseline when authentication is disabled", () => {
    const props = makeProps();
    const { rerender } = renderHook(
      (currentProps) => useAutoSelectNewRemoteConnection(currentProps),
      { initialProps: props },
    );

    rerender({ ...props, enabled: false, connections: [] });
    rerender({ ...props, enabled: true, connections: [remoteConnection] });

    expect(props.setSandboxPreference).not.toHaveBeenCalled();
    expect(props.setChatMode).not.toHaveBeenCalled();
  });
});
