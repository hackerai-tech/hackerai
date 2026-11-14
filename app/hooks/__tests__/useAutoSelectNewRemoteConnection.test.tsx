import { renderHook } from "@testing-library/react";
import { describe, expect, it, jest } from "@jest/globals";
import { useNewRemoteConnection } from "../useAutoSelectNewRemoteConnection";

const runner = { connectionId: "remote-1", isDesktop: false };
const desktop = { connectionId: "desktop-1", isDesktop: true };

describe("useNewRemoteConnection", () => {
  it("reports new runners for connection UI without treating initial connections as new", () => {
    const onNewConnection = jest.fn();
    const { rerender } = renderHook(useNewRemoteConnection, {
      initialProps: { connections: [runner], onNewConnection },
    });
    expect(onNewConnection).not.toHaveBeenCalled();
    rerender({
      connections: [runner, { connectionId: "remote-2", isDesktop: false }],
      onNewConnection,
    });
    expect(onNewConnection).toHaveBeenCalledWith({
      connectionId: "remote-2",
      isDesktop: false,
    });
  });

  it("ignores Desktop registration", () => {
    const onNewConnection = jest.fn();
    const { rerender } = renderHook(useNewRemoteConnection, {
      initialProps: { connections: [], onNewConnection },
    });
    rerender({ connections: [desktop], onNewConnection });
    expect(onNewConnection).not.toHaveBeenCalled();
  });
});
