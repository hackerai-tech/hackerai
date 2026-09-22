"use client";

import { useSyncExternalStore } from "react";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { isTauriEnvironment } from "./useTauri";
import { isAgentMode } from "@/lib/utils/mode-helpers";
import { useInitialConnectionPending } from "./useInitialConnectionPending";
import { connectionMatchesPreference } from "@/lib/sandbox/environment";

// The native environment is fixed for the page lifetime. Use a server snapshot
// so hydration starts with the same environment as the server render.
const subscribeToEnvironment = () => () => {};
const getServerEnvironment = () => false;

/** Share connection readiness between the composer and all Agent send paths. */
export function useSelectedComputerConnection() {
  const {
    chatMode,
    sandboxPreference,
    desktopBridgeStatus,
    desktopEnvironmentId,
    localConnections,
  } = useGlobalState();
  const isNative = useSyncExternalStore(
    subscribeToEnvironment,
    isTauriEnvironment,
    getServerEnvironment,
  );

  const selectedNativeDesktop =
    isNative &&
    (sandboxPreference === "desktop" ||
      (desktopEnvironmentId !== undefined &&
        sandboxPreference === `desktop-environment:${desktopEnvironmentId}`));
  const connected = selectedNativeDesktop
    ? desktopBridgeStatus === "connected"
    : localConnections?.some((connection) =>
        connectionMatchesPreference(connection, sandboxPreference),
      );

  const initialConnectionPending = useInitialConnectionPending({
    connected: Boolean(connected),
    connectionCount: localConnections?.length,
    preference: sandboxPreference,
  });
  const computerConnectionPending = selectedNativeDesktop
    ? desktopBridgeStatus === "idle" || desktopBridgeStatus === "connecting"
    : initialConnectionPending;
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
