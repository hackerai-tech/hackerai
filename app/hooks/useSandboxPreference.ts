"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { SandboxPreference } from "@/types/chat";
import { toast } from "sonner";
import { DesktopSandboxBridge } from "@/app/services/desktop-sandbox-bridge";
import { isTauriEnvironment } from "@/app/hooks/useTauri";

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
      // Default to Cloud on Desktop; user can switch to Local if desired
      // if (activeBridge?.getConnectionId())
      //   return activeBridge.getConnectionId()!;
      return "e2b";
    });

  const connectDesktopMutation = useMutation(api.localSandbox.connectDesktop);
  const refreshTokenMutation = useMutation(
    api.localSandbox.refreshCentrifugoTokenDesktop,
  );
  const disconnectMutation = useMutation(api.localSandbox.disconnectDesktop);

  const connectDesktopRef = useRef(connectDesktopMutation);
  const refreshTokenRef = useRef(refreshTokenMutation);
  const disconnectRef = useRef(disconnectMutation);
  useEffect(() => {
    connectDesktopRef.current = connectDesktopMutation;
    refreshTokenRef.current = refreshTokenMutation;
    disconnectRef.current = disconnectMutation;
  }, [connectDesktopMutation, refreshTokenMutation, disconnectMutation]);

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

    if (!isAuthenticated || !isTauriEnvironment()) {
      bridgeStateListener = null;
      bridgeGeneration += 1;
      bridgeStartPromise = null;
      const bridgeToStop = activeBridge;
      activeBridge = null;
      void bridgeToStop?.stop();
      syncBridgeState(false, "idle");
      return () => {
        cancelled = true;
      };
    }

    bridgeStateListener = updateBridgeState;

    // Already running — just sync bridge active state (keep Cloud as default)
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
      setDesktopBridgeActive(false);
      setDesktopBridgeStatus("connecting");
      try {
        if (!bridgeStartPromise) {
          const generation = bridgeGeneration;
          let bridge: DesktopSandboxBridge;
          bridge = new DesktopSandboxBridge({
            connectDesktop: (args) => connectDesktopRef.current(args),
            refreshCentrifugoTokenDesktop: (args) =>
              refreshTokenRef.current(args),
            disconnectDesktop: (args) => disconnectRef.current(args),
            onTerminated: (reason) => {
              if (generation !== bridgeGeneration) return;
              if (activeBridge === bridge) activeBridge = null;
              bridgeStateListener?.(false, "failed");
            },
          });

          let startPromise: Promise<DesktopSandboxBridge | null>;
          startPromise = bridge
            .start()
            .then(async () => {
              if (generation !== bridgeGeneration) {
                await bridge.stop();
                return null;
              }
              activeBridge = bridge;
              return bridge;
            })
            .catch(async (error) => {
              await bridge.stop();
              throw error;
            })
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
        // Keep Cloud selected by default; user can switch to Local if desired
        // setSandboxPreferenceState(connectionId);
      } catch (error) {
        if (cancelled) return;
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
