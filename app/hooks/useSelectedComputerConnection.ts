"use client";

import { useSyncExternalStore } from "react";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { isTauriEnvironment } from "./useTauri";
import { isAgentMode } from "@/lib/utils/mode-helpers";

// The native environment is fixed for the page lifetime. Use a server snapshot
// so hydration starts with the same environment as the server render.
const subscribeToEnvironment = () => () => {};
const getServerEnvironment = () => false;

/** Share connection readiness between the composer and all Agent send paths. */
export function useSelectedComputerConnection() {
  const { chatMode, sandboxPreference, desktopBridgeStatus, localConnections } =
    useGlobalState();
  const isNative = useSyncExternalStore(
    subscribeToEnvironment,
    isTauriEnvironment,
    getServerEnvironment,
  );

  const selectedNativeDesktop = sandboxPreference === "desktop" && isNative;
  const connected = selectedNativeDesktop
    ? desktopBridgeStatus === "connected"
    : localConnections?.some((connection) =>
        sandboxPreference === "desktop"
          ? connection.isDesktop
          : !connection.isDesktop &&
            connection.connectionId === sandboxPreference,
      );
  const computerConnectionPending = selectedNativeDesktop
    ? desktopBridgeStatus === "idle" || desktopBridgeStatus === "connecting"
    : localConnections === undefined;
  const selectedComputerUnavailable =
    isAgentMode(chatMode) && sandboxPreference !== "e2b" && !connected;
  const sendDisabledReason = selectedComputerUnavailable
    ? computerConnectionPending
      ? "Checking your computer connection"
      : "Reconnect your computer or choose another environment"
    : undefined;

  return {
    selectedNativeDesktop,
    computerConnectionPending,
    selectedComputerUnavailable,
    sendDisabledReason,
  };
}
