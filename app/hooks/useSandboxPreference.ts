"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { SandboxPreference } from "@/types/chat";
import { toast } from "sonner";
import { DesktopSandboxBridge } from "@/app/services/desktop-sandbox-bridge";

interface SandboxPreferenceState {
  sandboxPreference: SandboxPreference;
  setSandboxPreference: (preference: SandboxPreference) => void;
  desktopBridgeActive: boolean;
}

// Module-level singleton to survive React strict mode double-mount
let activeBridge: DesktopSandboxBridge | null = null;
let bridgeStarting = false;

export function useSandboxPreference(
  isAuthenticated: boolean,
): SandboxPreferenceState {
  const [desktopBridgeActive, setDesktopBridgeActive] = useState(false);

  const [sandboxPreference, setSandboxPreferenceState] =
    useState<SandboxPreference>(() => {
      if (typeof window === "undefined") return "e2b";
      const stored = localStorage.getItem("sandbox-preference");
      if (stored && stored !== "tauri") return stored as SandboxPreference;
      // If there's already an active bridge (HMR / remount), restore its connectionId
      if (activeBridge?.getConnectionId())
        return activeBridge.getConnectionId()!;
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
    if (!isAuthenticated) return;

    // Already running — just sync state
    if (activeBridge?.getConnectionId()) {
      setDesktopBridgeActive(true);
      setSandboxPreferenceState(activeBridge.getConnectionId()!);
      return;
    }

    // Another call is already starting the bridge
    if (bridgeStarting) return;

    let cancelled = false;

    async function startBridge() {
      bridgeStarting = true;
      try {
        const { isTauriEnvironment } = await import("@/app/hooks/useTauri");
        if (!isTauriEnvironment()) return;

        if (cancelled) return;

        // Double-check after async gap
        if (activeBridge?.getConnectionId()) return;

        const bridge = new DesktopSandboxBridge({
          connectDesktop: (args) => connectDesktopRef.current(args),
          refreshCentrifugoTokenDesktop: (args) =>
            refreshTokenRef.current(args),
          disconnectDesktop: (args) => disconnectRef.current(args),
        });

        const connectionId = await bridge.start();
        if (cancelled) {
          bridge.stop();
          return;
        }

        activeBridge = bridge;
        setDesktopBridgeActive(true);
        setSandboxPreferenceState(connectionId);
      } catch (error) {
        console.error("[DesktopSandboxBridge] Failed to start:", error);
        toast.error("Desktop sandbox failed to connect. Using cloud.");
      } finally {
        bridgeStarting = false;
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
  }, [isAuthenticated]);

  const PERSISTABLE_PREFERENCES = new Set(["e2b", "desktop"]);

  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    if (
      typeof window !== "undefined" &&
      PERSISTABLE_PREFERENCES.has(sandboxPreference)
    ) {
      localStorage.setItem("sandbox-preference", sandboxPreference);
    }
  }, [sandboxPreference]);

  const setSandboxPreference = useCallback((preference: SandboxPreference) => {
    setSandboxPreferenceState(preference);
  }, []);

  return { sandboxPreference, setSandboxPreference, desktopBridgeActive };
}
