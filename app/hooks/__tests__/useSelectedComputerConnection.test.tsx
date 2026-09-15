import { act } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { describe, expect, it, jest } from "@jest/globals";

jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({
    chatMode: "agent",
    sandboxPreference: "desktop",
    desktopBridgeStatus: "failed",
    localConnections: [{ connectionId: "stale-row", isDesktop: true }],
  }),
}));
jest.mock("../useTauri", () => ({ isTauriEnvironment: () => true }));

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
});
