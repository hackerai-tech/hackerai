"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { SandboxPreference } from "@/types/chat";
import { toast } from "sonner";
import type { DesktopSandboxBridge } from "@/app/services/desktop-sandbox-bridge";
import {
  DESKTOP_UPDATE_URL,
  isTauriEnvironment,
  openInBrowser,
} from "@/app/hooks/useTauri";
import { getDesktopFileFailure } from "@/lib/centrifugo/desktop-file-errors";
import {
  captureAuthenticatedEvent,
  subscribeAuthenticatedAnalytics,
} from "@/lib/analytics/client";
import { isEnvironmentPreference } from "@/lib/sandbox/environment";
import { isUnauthenticatedConvexError } from "@/lib/auth/expected-auth-errors";
import { DesktopRelayTelemetry } from "@/lib/analytics/desktop-relay";

export type DesktopBridgeStatus =
  "idle" | "connecting" | "connected" | "failed";

export type SetSandboxPreference = (
  preference: SandboxPreference,
  options?: { remember?: boolean },
) => void;

interface SandboxPreferenceState {
  sandboxPreference: SandboxPreference;
  hasExplicitSandboxPreference: boolean;
  setSandboxPreference: SetSandboxPreference;
  resetSandboxPreference: () => void;
  desktopBridgeActive: boolean;
  desktopBridgeStatus: DesktopBridgeStatus;
  desktopEnvironmentId?: string;
  retryDesktopBridge: () => void;
}

// Module-level singleton to survive React strict mode double-mount
let activeBridge: DesktopSandboxBridge | null = null;
let bridgeStartPromise: Promise<DesktopSandboxBridge | null> | null = null;
let bridgeGeneration = 0;
let bridgeStateListener:
  | ((
      active: boolean,
      status: DesktopBridgeStatus,
      environmentId?: string,
    ) => void)
  | null = null;
let bridgeRetryListener: (() => void) | null = null;
let bridgeStatus: DesktopBridgeStatus = "idle";
let bridgeEnvironmentId: string | undefined;

function publishBridgeState(
  active: boolean,
  status: DesktopBridgeStatus,
  environmentId?: string,
): void {
  bridgeStatus = status;
  if (environmentId) bridgeEnvironmentId = environmentId;
  bridgeStateListener?.(active, status, bridgeEnvironmentId);
}

const DESKTOP_BRIDGE_RECOVERY_DELAYS_MS = [
  1_000, 3_000, 8_000, 16_000, 30_000, 60_000,
];
const DESKTOP_BRIDGE_MAX_RECOVERY_ATTEMPTS = 6;
// Brief recoveries during an origin outage must not continually refill the budget.
const DESKTOP_BRIDGE_STABLE_RESET_MS = 5 * 60_000;
const DESKTOP_BRIDGE_RESUME_COOLDOWN_MS = 60_000;
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
// Only transient failures may be retried on wake/network recovery. Never
// restart a bridge terminated by an authentication or ownership failure.
let bridgeRecoveryExhausted = false;
let bridgeRecoveryPausedOffline = false;
let bridgeRecoveryResumeAt = 0;
const bridgeTelemetry = new DesktopRelayTelemetry(captureAuthenticatedEvent);

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
  const [desktopEnvironmentId, setDesktopEnvironmentId] = useState<string>();

  const [sandboxPreference, setSandboxPreferenceState] =
    useState<SandboxPreference>(() => {
      if (typeof window === "undefined") return "e2b";
      const stored = localStorage.getItem("sandbox-preference");
      if (stored)
        return stored === "tauri" ? "desktop" : (stored as SandboxPreference);
      return isTauriEnvironment() ? "desktop" : "e2b";
    });

  const [hasExplicitSandboxPreference, setHasExplicitSandboxPreference] =
    useState(
      () =>
        typeof window !== "undefined" &&
        Boolean(localStorage.getItem("sandbox-preference")),
    );
  const newChatPreferenceRef = useRef(sandboxPreference);
  const resolvedPreference = useQuery(
    api.localSandbox.resolveEnvironmentPreference,
    isAuthenticated &&
      sandboxPreference !== "desktop" &&
      sandboxPreference !== "e2b" &&
      !isEnvironmentPreference(sandboxPreference)
      ? { preference: sandboxPreference }
      : "skip",
  );
  const upgradedPreference =
    sandboxPreference === "desktop" && desktopEnvironmentId
      ? `desktop-environment:${desktopEnvironmentId}`
      : resolvedPreference;
  useEffect(() => {
    if (
      typeof upgradedPreference !== "string" ||
      !isEnvironmentPreference(upgradedPreference)
    )
      return;
    if (newChatPreferenceRef.current === sandboxPreference) {
      newChatPreferenceRef.current = upgradedPreference;
      if (localStorage.getItem("sandbox-preference") === sandboxPreference) {
        localStorage.setItem("sandbox-preference", upgradedPreference);
      }
    }
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setSandboxPreferenceState((current) =>
        current === sandboxPreference ? upgradedPreference : current,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [upgradedPreference, sandboxPreference]);

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
      environmentId?: string,
    ) => {
      if (cancelled) return;
      if (environmentId) setDesktopEnvironmentId(environmentId);
      setDesktopBridgeActive(active);
      setDesktopBridgeStatus(status);
    };
    const syncBridgeState = (active: boolean, status: DesktopBridgeStatus) => {
      queueMicrotask(() => {
        updateBridgeState(active, status);
      });
    };
    const syncDesktopEnvironmentId = (environmentId: string | undefined) => {
      queueMicrotask(() => {
        if (!cancelled) setDesktopEnvironmentId(environmentId);
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
        clearBridgeRecovery(false);
        bridgeRecoveryExhausted = true;
        bridgeRecoveryPausedOffline = false;
        bridgeRecoveryResumeAt = Date.now() + DESKTOP_BRIDGE_RESUME_COOLDOWN_MS;
        publishBridgeState(false, "failed");
        return true;
      }
      if (navigator.onLine === false) {
        bridgeRecoveryPausedOffline = true;
        publishBridgeState(false, "connecting");
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
      bridgeTelemetry.record("desktop_bridge_recovery_scheduled", {
        clientSurface: "desktop_bridge",
        reason,
        attempt,
        delayMs,
      });
      publishBridgeState(false, "connecting");
      bridgeRecoveryTimer = setTimeout(() => {
        bridgeRecoveryTimer = null;
        if (generation !== bridgeGeneration) return;
        bridgeGeneration += 1;
        bridgeStartPromise = null;
        bridgeRetryListener?.();
      }, delayMs);
      return true;
    };

    if (!isAuthenticated || !isTauriEnvironment()) {
      bridgeRecoveryExhausted = false;
      bridgeRecoveryPausedOffline = false;
      bridgeRecoveryResumeAt = 0;
      // Never carry diagnostics from a signed-out user into another session.
      bridgeTelemetry.reset();
      syncDesktopEnvironmentId(undefined);
      bridgeStateListener = null;
      bridgeRetryListener = null;
      bridgeStatus = "idle";
      bridgeEnvironmentId = undefined;
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
    const requestBridgeRetry = () =>
      setDesktopBridgeRetryAttempt((attempt) => attempt + 1);
    bridgeRetryListener = requestBridgeRetry;

    // The singleton survives remounts; its events and timers must target the
    // currently mounted consumer, not the component that first started it.
    const handleBeforeUnload = () => {
      bridgeTelemetry.flush();
      bridgeGeneration += 1;
      clearBridgeRecovery(true);
      bridgeStartPromise = null;
      bridgeStateListener = null;
      bridgeRetryListener = null;
      bridgeStatus = "idle";
      bridgeEnvironmentId = undefined;
      void activeBridge?.stop();
      activeBridge = null;
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    const cleanup = () => {
      cancelled = true;
      if (bridgeStateListener === updateBridgeState) bridgeStateListener = null;
      if (bridgeRetryListener === requestBridgeRetry)
        bridgeRetryListener = null;
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };

    // A connection ID survives transient transport outages. Preserve the
    // actual readiness state and any backoff instead of declaring it ready.
    if (
      activeBridge?.getConnectionId() ||
      bridgeRecoveryTimer ||
      bridgeStatus === "failed" ||
      bridgeRecoveryExhausted
    ) {
      syncDesktopEnvironmentId(
        bridgeEnvironmentId ?? activeBridge?.getEnvironmentId?.(),
      );
      syncBridgeState(bridgeStatus === "connected", bridgeStatus);
      return cleanup;
    }

    if (navigator.onLine === false) {
      bridgeRecoveryPausedOffline = true;
      bridgeStatus = "connecting";
      syncBridgeState(false, "connecting");
      return cleanup;
    }
    bridgeRecoveryPausedOffline = false;

    async function startBridge() {
      const startGeneration = bridgeGeneration;
      publishBridgeState(false, "connecting");
      try {
        if (!bridgeStartPromise) {
          const generation = startGeneration;
          let startPromise: Promise<DesktopSandboxBridge | null>;
          startPromise = import("@/app/services/desktop-sandbox-bridge")
            .then(
              async ({ DesktopSandboxBridge: DesktopSandboxBridgeClass }) => {
                if (generation !== bridgeGeneration) return null;

                const bridge = new DesktopSandboxBridgeClass({
                  relayTelemetry: bridgeTelemetry,
                  connectDesktop: (args) => connectDesktopRef.current(args),
                  refreshCentrifugoTokenDesktop: (args) =>
                    refreshTokenRef.current(args),
                  disconnectDesktop: (args) => disconnectRef.current(args),
                  heartbeatDesktop: (args) => heartbeatRef.current(args),
                  onConnectionState: (state, environmentId) => {
                    if (generation !== bridgeGeneration) return;
                    if (state === "connected") {
                      bridgeRecoveryExhausted = false;
                      scheduleStableRecoveryReset(generation);
                    } else if (bridgeStableResetTimer) {
                      clearTimeout(bridgeStableResetTimer);
                      bridgeStableResetTimer = null;
                    }
                    publishBridgeState(
                      state === "connected",
                      state,
                      environmentId,
                    );
                  },
                  onTerminated: (reason) => {
                    if (generation !== bridgeGeneration) return;
                    if (activeBridge === bridge) activeBridge = null;
                    if (!isRecoverableDesktopTermination(reason)) {
                      bridgeRecoveryExhausted = false;
                      bridgeRecoveryPausedOffline = false;
                      clearBridgeRecovery(true);
                      publishBridgeState(false, "failed");
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

        publishBridgeState(true, "connected", bridge.getEnvironmentId?.());
      } catch (error) {
        if (cancelled) return;
        if (getDesktopFileFailure(error) === "native_ipc_denied") {
          bridgeRecoveryExhausted = false;
          bridgeRecoveryPausedOffline = false;
          clearBridgeRecovery(true);
          publishBridgeState(false, "failed");
          toast.error("HackerAI Desktop can't access files", {
            id: "desktop-file-access-denied",
            duration: 20_000,
            description:
              "Install the latest version, then fully quit and reopen the app. If it still fails, contact support.",
            action: {
              label: "Download update",
              onClick: () => {
                void openInBrowser(DESKTOP_UPDATE_URL).then((opened) => {
                  if (!opened) window.location.href = DESKTOP_UPDATE_URL;
                });
              },
            },
          });
          return;
        }
        if (isUnauthenticatedConvexError(error)) {
          // Registration can reject before the bridge has a connection to
          // terminate. Match the heartbeat/token path: wait for an explicit
          // retry or a fresh sign-in instead of retrying the same auth failure.
          bridgeRecoveryExhausted = false;
          bridgeRecoveryPausedOffline = false;
          clearBridgeRecovery(true);
        } else {
          if (bridgeRecoveryTimer) {
            setDesktopBridgeActive(false);
            setDesktopBridgeStatus("connecting");
            return;
          }
          if (scheduleBridgeRecovery("startup_failed", startGeneration)) return;
        }
        console.error("[DesktopSandboxBridge] Failed to start:", error);
        publishBridgeState(false, "failed");
        toast.error("Desktop sandbox failed to connect.", {
          description: "Retry the local connection to use Agent mode.",
        });
      }
    }

    startBridge();

    return cleanup;
  }, [desktopBridgeRetryAttempt, isAuthenticated]);

  useEffect(() => {
    // Auth/account and consent changes invalidate pending aggregates too.
    const unsubscribe = subscribeAuthenticatedAnalytics(() =>
      bridgeTelemetry.reset(),
    );
    const flush = () => bridgeTelemetry.flush();
    window.addEventListener("pagehide", flush);
    return () => {
      unsubscribe();
      window.removeEventListener("pagehide", flush);
    };
  }, []);

  // Restoring a task or applying an availability/plan default must not change
  // the user's default for new chats. Only an explicit choice is remembered.
  const setSandboxPreference: SetSandboxPreference = useCallback(
    (preference, { remember = true } = {}) => {
      setSandboxPreferenceState(preference);
      if (remember) {
        setHasExplicitSandboxPreference(true);
        newChatPreferenceRef.current = preference;
        localStorage.setItem("sandbox-preference", preference);
      }
    },
    [],
  );

  const resetSandboxPreference = useCallback(() => {
    setSandboxPreferenceState(newChatPreferenceRef.current);
  }, []);

  const retryDesktopBridge = useCallback(() => {
    if (!isAuthenticated || !isTauriEnvironment()) return;
    // A live bridge owns its bounded transport recovery. Keep its callbacks
    // valid (and any running commands intact) when Retry is clicked mid-reconnect.
    if (activeBridge?.getConnectionId()) return;
    bridgeGeneration += 1;
    bridgeRecoveryExhausted = false;
    bridgeRecoveryPausedOffline = false;
    bridgeRecoveryResumeAt = 0;
    clearBridgeRecovery(true);
    bridgeStartPromise = null;
    publishBridgeState(false, "connecting");
    setDesktopBridgeRetryAttempt((attempt) => attempt + 1);
  }, [isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated || !isTauriEnvironment()) return;
    const resumeRecovery = (event: Event) => {
      if (
        (!bridgeRecoveryExhausted && !bridgeRecoveryPausedOffline) ||
        navigator.onLine === false ||
        (bridgeRecoveryExhausted && Date.now() < bridgeRecoveryResumeAt) ||
        (event.type !== "online" && document.visibilityState === "hidden") ||
        activeBridge?.getConnectionId() ||
        bridgeStartPromise ||
        bridgeRecoveryTimer
      )
        return;
      if (bridgeRecoveryPausedOffline) {
        bridgeRecoveryPausedOffline = false;
        bridgeGeneration += 1;
        setDesktopBridgeRetryAttempt((attempt) => attempt + 1);
      } else {
        retryDesktopBridge();
      }
    };
    window.addEventListener("online", resumeRecovery);
    window.addEventListener("focus", resumeRecovery);
    document.addEventListener("visibilitychange", resumeRecovery);
    return () => {
      window.removeEventListener("online", resumeRecovery);
      window.removeEventListener("focus", resumeRecovery);
      document.removeEventListener("visibilitychange", resumeRecovery);
    };
  }, [isAuthenticated, retryDesktopBridge]);

  return {
    sandboxPreference:
      typeof upgradedPreference === "string" &&
      isEnvironmentPreference(upgradedPreference)
        ? upgradedPreference
        : sandboxPreference,
    hasExplicitSandboxPreference,
    setSandboxPreference,
    resetSandboxPreference,
    desktopBridgeActive,
    desktopBridgeStatus,
    desktopEnvironmentId,
    retryDesktopBridge,
  };
}
