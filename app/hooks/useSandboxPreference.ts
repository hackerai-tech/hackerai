"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { SandboxPreference } from "@/types/chat";
import { toast } from "sonner";
import type { DesktopSandboxBridge } from "@/app/services/desktop-sandbox-bridge";
import { isTauriEnvironment } from "@/app/hooks/useTauri";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";

export type DesktopBridgeStatus =
  "idle" | "connecting" | "connected" | "failed";

interface SandboxPreferenceState {
  sandboxPreference: SandboxPreference;
  setSandboxPreference: (preference: SandboxPreference) => void;
  desktopBridgeActive: boolean;
  desktopBridgeStatus: DesktopBridgeStatus;
  retryDesktopBridge: () => void;
}

// Module-level singleton to survive React strict mode double-mount
let activeBridge: DesktopSandboxBridge | null = null;
let bridgeStartPromise: Promise<DesktopSandboxBridge | null> | null = null;
let bridgeGeneration = 0;
let bridgeStateListener:
  ((active: boolean, status: DesktopBridgeStatus) => void) | null = null;
const PERSISTABLE_SANDBOX_PREFERENCES = new Set(["e2b", "desktop"]);
const DESKTOP_BRIDGE_RECOVERY_DELAYS_MS = [1_000, 3_000, 8_000, 16_000];
const DESKTOP_BRIDGE_MAX_RECOVERY_ATTEMPTS = 6;
const DESKTOP_BRIDGE_STABLE_RESET_MS = 60_000;
type RecoverableDesktopTerminationReason =
  "connection_not_found" | "connection_inactive" | "transport_disconnected";
type DesktopBridgeRecoveryReason =
  RecoverableDesktopTerminationReason | "startup_failed";
const RECOVERABLE_DESKTOP_TERMINATIONS =
  new Set<RecoverableDesktopTerminationReason>([
    "connection_not_found",
    "connection_inactive",
    "transport_disconnected",
  ]);

function isRecoverableDesktopTermination(
  reason: string,
): reason is RecoverableDesktopTerminationReason {
  return RECOVERABLE_DESKTOP_TERMINATIONS.has(
    reason as RecoverableDesktopTerminationReason,
  );
}
let bridgeRecoveryAttempt = 0;
let bridgeRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
let bridgeStableResetTimer: ReturnType<typeof setTimeout> | null = null;

function clearBridgeRecovery(resetAttempt: boolean): void {
  if (bridgeRecoveryTimer) {
    clearTimeout(bridgeRecoveryTimer);
    bridgeRecoveryTimer = null;
  }
  if (bridgeStableResetTimer) {
    clearTimeout(bridgeStableResetTimer);
    bridgeStableResetTimer = null;
  }
  if (resetAttempt) {
    bridgeRecoveryAttempt = 0;
  }
}

function scheduleStableRecoveryReset(generation: number): void {
  if (bridgeStableResetTimer) clearTimeout(bridgeStableResetTimer);
  bridgeStableResetTimer = setTimeout(() => {
    bridgeStableResetTimer = null;
    if (generation !== bridgeGeneration) return;
    bridgeRecoveryAttempt = 0;
  }, DESKTOP_BRIDGE_STABLE_RESET_MS);
}

export function useSandboxPreference(
  isAuthenticated: boolean,
): SandboxPreferenceState {
  const [desktopBridgeActive, setDesktopBridgeActive] = useState(false);
  const [desktopBridgeStatus, setDesktopBridgeStatus] =
    useState<DesktopBridgeStatus>("idle");
  const [desktopBridgeRetryAttempt, setDesktopBridgeRetryAttempt] = useState(0);

  const [sandboxPreference, setSandboxPreferenceState] =
    useState<SandboxPreference>(() => {
      if (typeof window === "undefined") return "e2b";
      const stored = localStorage.getItem("sandbox-preference");
      if (stored && stored !== "tauri") return stored as SandboxPreference;
      return isTauriEnvironment() ? "desktop" : "e2b";
    });

  const connectDesktopMutation = useMutation(api.localSandbox.connectDesktop);
  const refreshTokenMutation = useMutation(
    api.localSandbox.refreshCentrifugoTokenDesktop,
  );
  const disconnectMutation = useMutation(api.localSandbox.disconnectDesktop);

  const heartbeatMutation = useMutation(api.localSandbox.heartbeatDesktop);
  const connectDesktopRef = useRef(connectDesktopMutation);
  const refreshTokenRef = useRef(refreshTokenMutation);
  const disconnectRef = useRef(disconnectMutation);
  const heartbeatRef = useRef(heartbeatMutation);
  useEffect(() => {
    connectDesktopRef.current = connectDesktopMutation;
    refreshTokenRef.current = refreshTokenMutation;
    disconnectRef.current = disconnectMutation;
    heartbeatRef.current = heartbeatMutation;
  }, [
    connectDesktopMutation,
    refreshTokenMutation,
    disconnectMutation,
    heartbeatMutation,
  ]);

  useEffect(() => {
    let cancelled = false;
    const updateBridgeState = (
      active: boolean,
      status: DesktopBridgeStatus,
    ) => {
      if (cancelled) return;
      setDesktopBridgeActive(active);
      setDesktopBridgeStatus(status);
    };
    const syncBridgeState = (active: boolean, status: DesktopBridgeStatus) => {
      queueMicrotask(() => {
        updateBridgeState(active, status);
      });
    };
    const scheduleBridgeRecovery = (
      reason: DesktopBridgeRecoveryReason,
      generation: number,
    ): boolean => {
      if (generation !== bridgeGeneration) return false;

      clearBridgeRecovery(false);
      if (bridgeRecoveryAttempt >= DESKTOP_BRIDGE_MAX_RECOVERY_ATTEMPTS) {
        const attempts = bridgeRecoveryAttempt;
        console.warn("[DesktopSandboxBridge] Automatic recovery exhausted", {
          reason,
          attempts,
        });
        captureAuthenticatedEvent("desktop_bridge_recovery_exhausted", {
          clientSurface: "desktop_bridge",
          reason,
          attempts,
        });
        clearBridgeRecovery(true);
        updateBridgeState(false, "failed");
        return true;
      }

      const delayMs =
        DESKTOP_BRIDGE_RECOVERY_DELAYS_MS[
          Math.min(
            bridgeRecoveryAttempt,
            DESKTOP_BRIDGE_RECOVERY_DELAYS_MS.length - 1,
          )
        ];
      bridgeRecoveryAttempt += 1;
      const attempt = bridgeRecoveryAttempt;
      console.warn("[DesktopSandboxBridge] Automatic recovery scheduled", {
        reason,
        attempt,
        delayMs,
      });
      captureAuthenticatedEvent("desktop_bridge_recovery_scheduled", {
        clientSurface: "desktop_bridge",
        reason,
        attempt,
        delayMs,
      });
      updateBridgeState(false, "connecting");
      bridgeRecoveryTimer = setTimeout(() => {
        bridgeRecoveryTimer = null;
        if (generation !== bridgeGeneration) return;
        bridgeGeneration += 1;
        bridgeStartPromise = null;
        setDesktopBridgeRetryAttempt((currentAttempt) => currentAttempt + 1);
      }, delayMs);
      return true;
    };

    if (!isAuthenticated || !isTauriEnvironment()) {
      bridgeStateListener = null;
      bridgeGeneration += 1;
      bridgeStartPromise = null;
      const bridgeToStop = activeBridge;
      activeBridge = null;
      clearBridgeRecovery(true);
      void bridgeToStop?.stop();
      syncBridgeState(false, "idle");
      return () => {
        cancelled = true;
      };
    }

    bridgeStateListener = updateBridgeState;

    // Already running — just sync bridge active state.
    if (activeBridge?.getConnectionId()) {
      syncBridgeState(true, "connected");
      // setSandboxPreferenceState(activeBridge.getConnectionId()!);
      return () => {
        cancelled = true;
        if (bridgeStateListener === updateBridgeState) {
          bridgeStateListener = null;
        }
      };
    }

    async function startBridge() {
      const startGeneration = bridgeGeneration;
      setDesktopBridgeActive(false);
      setDesktopBridgeStatus("connecting");
      try {
        if (!bridgeStartPromise) {
          const generation = startGeneration;
          let startPromise: Promise<DesktopSandboxBridge | null>;
          startPromise = import("@/app/services/desktop-sandbox-bridge")
            .then(
              async ({ DesktopSandboxBridge: DesktopSandboxBridgeClass }) => {
                if (generation !== bridgeGeneration) return null;

                const bridge = new DesktopSandboxBridgeClass({
                  connectDesktop: (args) => connectDesktopRef.current(args),
                  refreshCentrifugoTokenDesktop: (args) =>
                    refreshTokenRef.current(args),
                  disconnectDesktop: (args) => disconnectRef.current(args),
                  heartbeatDesktop: (args) => heartbeatRef.current(args),
                  onConnectionState: (state) => {
                    if (generation !== bridgeGeneration) return;
                    if (state === "connected") {
                      scheduleStableRecoveryReset(generation);
                    }
                    bridgeStateListener?.(state === "connected", state);
                  },
                  onTerminated: (reason) => {
                    if (generation !== bridgeGeneration) return;
                    if (activeBridge === bridge) activeBridge = null;
                    if (!isRecoverableDesktopTermination(reason)) {
                      clearBridgeRecovery(true);
                      bridgeStateListener?.(false, "failed");
                      return;
                    }
                    scheduleBridgeRecovery(reason, generation);
                  },
                });

                try {
                  await bridge.start();
                } catch (error) {
                  await bridge.stop();
                  throw error;
                }

                if (generation !== bridgeGeneration) {
                  await bridge.stop();
                  return null;
                }
                activeBridge = bridge;
                return bridge;
              },
            )
            .finally(() => {
              if (bridgeStartPromise === startPromise) {
                bridgeStartPromise = null;
              }
            });
          bridgeStartPromise = startPromise;
        }

        const bridge = await bridgeStartPromise;
        if (cancelled || !bridge) return;

        setDesktopBridgeActive(true);
        setDesktopBridgeStatus("connected");
      } catch (error) {
        if (cancelled) return;
        if (bridgeRecoveryTimer) {
          setDesktopBridgeActive(false);
          setDesktopBridgeStatus("connecting");
          return;
        }
        if (scheduleBridgeRecovery("startup_failed", startGeneration)) return;
        console.error("[DesktopSandboxBridge] Failed to start:", error);
        setDesktopBridgeActive(false);
        setDesktopBridgeStatus("failed");
        toast.error("Desktop sandbox failed to connect.", {
          description: "Retry the local connection to use Agent mode.",
        });
      }
    }

    startBridge();

    // Cleanup on beforeunload (page close/refresh)
    const handleBeforeUnload = () => {
      bridgeGeneration += 1;
      clearBridgeRecovery(true);
      bridgeStartPromise = null;
      bridgeStateListener = null;
      try {
        activeBridge?.stop();
      } catch {
        // Best-effort
      }
      activeBridge = null;
    };
    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      cancelled = true;
      if (bridgeStateListener === updateBridgeState) {
        bridgeStateListener = null;
      }
      window.removeEventListener("beforeunload", handleBeforeUnload);
      // Don't tear down the bridge on React strict mode unmount —
      // it's a module-level singleton that persists across remounts.
    };
  }, [desktopBridgeRetryAttempt, isAuthenticated]);

  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    if (
      typeof window !== "undefined" &&
      PERSISTABLE_SANDBOX_PREFERENCES.has(sandboxPreference)
    ) {
      localStorage.setItem("sandbox-preference", sandboxPreference);
    }
  }, [sandboxPreference]);

  const setSandboxPreference = useCallback((preference: SandboxPreference) => {
    setSandboxPreferenceState(preference);
  }, []);

  const retryDesktopBridge = useCallback(() => {
    if (!isAuthenticated || !isTauriEnvironment()) return;
    bridgeGeneration += 1;
    clearBridgeRecovery(true);
    bridgeStartPromise = null;
    setDesktopBridgeActive(false);
    setDesktopBridgeStatus("connecting");
    setDesktopBridgeRetryAttempt((attempt) => attempt + 1);
  }, [isAuthenticated]);

  return {
    sandboxPreference,
    setSandboxPreference,
    desktopBridgeActive,
    desktopBridgeStatus,
    retryDesktopBridge,
  };
}
