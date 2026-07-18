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
let bridgeStartPromise: Promise<DesktopSandboxBridge> | null = null;
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
    const syncBridgeState = (active: boolean, status: DesktopBridgeStatus) => {
      queueMicrotask(() => {
        if (cancelled) return;
        setDesktopBridgeActive(active);
        setDesktopBridgeStatus(status);
      });
    };

    if (!isAuthenticated || !isTauriEnvironment()) {
      syncBridgeState(false, "idle");
      return () => {
        cancelled = true;
      };
    }

    // Already running — just sync bridge active state (keep Cloud as default)
    if (activeBridge?.getConnectionId()) {
      syncBridgeState(true, "connected");
      // setSandboxPreferenceState(activeBridge.getConnectionId()!);
      return () => {
        cancelled = true;
      };
    }

    async function startBridge() {
      setDesktopBridgeActive(false);
      setDesktopBridgeStatus("connecting");
      try {
        if (!bridgeStartPromise) {
          const bridge = new DesktopSandboxBridge({
            connectDesktop: (args) => connectDesktopRef.current(args),
            refreshCentrifugoTokenDesktop: (args) =>
              refreshTokenRef.current(args),
            disconnectDesktop: (args) => disconnectRef.current(args),
          });

          bridgeStartPromise = bridge
            .start()
            .then(() => {
              activeBridge = bridge;
              return bridge;
            })
            .catch(async (error) => {
              await bridge.stop();
              throw error;
            })
            .finally(() => {
              bridgeStartPromise = null;
            });
        }

        await bridgeStartPromise;
        if (cancelled) return;

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
