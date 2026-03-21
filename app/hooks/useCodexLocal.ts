"use client";

import { useState, useCallback, useRef } from "react";
import { isTauriEnvironment } from "./useTauri";
import type { CodexLocalTransport } from "@/lib/local-providers/codex-transport";

interface CodexSidecarState {
  ready: boolean;
  starting: boolean;
  error: string | null;
  ensureSidecar: () => Promise<boolean>;
}

/**
 * Manages the codex app-server process via Tauri IPC.
 * Spawns `codex app-server --listen stdio://` on demand and
 * starts the transport's event listener.
 */
export function useCodexSidecar(
  transport: CodexLocalTransport | null,
): CodexSidecarState {
  const [ready, setReady] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);

  const ensureSidecar = useCallback(async (): Promise<boolean> => {
    if (startedRef.current && ready) return true;

    if (!isTauriEnvironment()) {
      setError("Not in desktop environment");
      return false;
    }

    if (!transport) {
      setError("Transport not initialized");
      return false;
    }

    setStarting(true);
    setError(null);

    try {
      const { invoke } = await import("@tauri-apps/api/core");

      // Check if already running
      const running = await invoke<boolean>("get_codex_app_server_info");
      if (!running) {
        console.log("[CodexAppServer] Starting codex app-server (stdio)...");
        await invoke("start_codex_app_server");
        console.log("[CodexAppServer] Started");
      } else {
        console.log("[CodexAppServer] Already running");
      }

      // Start listening for Tauri events
      await transport.startListening();

      startedRef.current = true;
      setReady(true);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[CodexAppServer] Start failed:", message);
      setError(message);
      return false;
    } finally {
      setStarting(false);
    }
  }, [transport, ready]);

  return { ready, starting, error, ensureSidecar };
}
