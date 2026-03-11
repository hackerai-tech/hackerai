"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { SandboxPreference } from "@/types/chat";

interface SandboxPreferenceState {
  tauriCmdServer: { port: number; token: string } | null;
  sandboxPreference: SandboxPreference;
  setSandboxPreference: (preference: SandboxPreference) => void;
}

/**
 * Co-locates Tauri detection, sandbox preference, and localStorage persistence
 * so that all state transitions for these two values live in one place.
 */
export function useSandboxPreference(): SandboxPreferenceState {
  const [tauriCmdServer, setTauriCmdServer] = useState<{
    port: number;
    token: string;
  } | null>(null);

  const [sandboxPreference, setSandboxPreferenceState] =
    useState<SandboxPreference>(() => {
      if (typeof window === "undefined") return "e2b";
      const stored = localStorage.getItem("sandbox-preference");
      // "tauri" is no longer a valid sandbox preference (local execution
      // doesn't work in production Tauri builds). Treat it as unset.
      if (stored && stored !== "tauri") return stored as SandboxPreference;
      return "e2b";
    });

  // Detect Tauri environment for features that use the local command server
  // directly from the frontend (e.g. saveFileToLocal, revealFileInDir).
  // NOTE: We no longer set sandboxPreference to "tauri" — local command
  // execution via the server-side sandbox doesn't work in production Tauri
  // builds because the remote API can't reach 127.0.0.1 on the user's machine.
  useEffect(() => {
    let cancelled = false;

    async function detectTauri() {
      try {
        const { getCmdServerInfo, isTauriEnvironment } =
          await import("@/app/hooks/useTauri");
        if (!isTauriEnvironment()) return;

        const info = await getCmdServerInfo();
        if (!info || cancelled) return;

        setTauriCmdServer(info);

        // TODO: Re-enable when client-side tool execution is implemented for Tauri production builds
        // In production Tauri builds, the remote API server cannot reach 127.0.0.1 on the user's machine.
        // Only default to "tauri" when the user hasn't explicitly chosen yet
        // const savedPref =
        //   typeof window !== "undefined"
        //     ? localStorage.getItem("sandbox-preference")
        //     : null;
        // if (!savedPref || savedPref === "tauri") {
        //   setSandboxPreferenceState("tauri");
        // }
      } catch {
        // Not in Tauri environment — leave defaults
      }
    }

    detectTauri();
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist sandbox preference to localStorage — skip the initial mount
  // since useState already read from localStorage (avoids a redundant write)
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    if (typeof window !== "undefined") {
      localStorage.setItem("sandbox-preference", sandboxPreference);
    }
  }, [sandboxPreference]);

  // Controlled setter — the only way external code can change the preference
  const setSandboxPreference = useCallback((preference: SandboxPreference) => {
    setSandboxPreferenceState(preference);
  }, []);

  return { tauriCmdServer, sandboxPreference, setSandboxPreference };
}
