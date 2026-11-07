"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { isTauriEnvironment } from "./useTauri";
import { isAgentMode } from "@/lib/utils/mode-helpers";
import { useInitialConnectionPending } from "./useInitialConnectionPending";
import { connectionMatchesPreference } from "@/lib/sandbox/environment";
import { LOCAL_SANDBOX_PRESENCE_GRACE_MS } from "@/lib/centrifugo/presence";

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
  const [now, setNow] = useState(Date.now);
  const latestHeartbeat = Math.max(
    ...(localConnections ?? [])
      .filter(
        (connection) =>
          connection.isDesktop &&
          connectionMatchesPreference(connection, sandboxPreference),
      )
      .map((connection) => connection.lastSeen)
      .filter(Number.isFinite),
  );
  useEffect(() => {
    if (selectedNativeDesktop || !Number.isFinite(latestHeartbeat)) return;
    // A closed/crashed computer may never persist its disconnect. Age the
    // last heartbeat even when Convex has no new row update to push.
    // CLI clients have no periodic heartbeat, so only Desktop rows expire here.
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.max(
        0,
        latestHeartbeat + LOCAL_SANDBOX_PRESENCE_GRACE_MS - Date.now() + 1,
      ),
    );
    return () => window.clearTimeout(timer);
  }, [selectedNativeDesktop, latestHeartbeat]);
  const connected = selectedNativeDesktop
    ? desktopBridgeStatus === "connected"
    : localConnections?.some(
        (connection) =>
          connectionMatchesPreference(connection, sandboxPreference) &&
          (!connection.isDesktop ||
            (Number.isFinite(connection.lastSeen) &&
              now - connection.lastSeen <= LOCAL_SANDBOX_PRESENCE_GRACE_MS)),
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
