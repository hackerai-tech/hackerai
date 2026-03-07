"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { isTauriEnvironment } from "./useTauri";
import type {
  DesktopSandboxClient,
  DesktopSandboxStatus,
} from "@/lib/desktop-sandbox";

/** Special sandbox preference value for "Desktop" in Tauri */
export const DESKTOP_SANDBOX_ID = "desktop";

interface UseDesktopSandboxOptions {
  /** Current sandbox preference from global state */
  sandboxPreference: string;
  /** Setter to update sandbox preference (e.g. swap "desktop" → real connectionId) */
  setSandboxPreference: (value: string) => void;
}

interface UseDesktopSandboxReturn {
  /** Whether the desktop sandbox feature is available (running in Tauri) */
  isAvailable: boolean;
  /** Whether the desktop sandbox is currently connecting */
  isConnecting: boolean;
  /** Current status */
  status: DesktopSandboxStatus;
  /** Error message if connection failed */
  error: string | null;
}

/**
 * Manages the desktop sandbox lifecycle reactively based on sandbox preference.
 *
 * When the user selects "Desktop" in the sandbox selector (preference = "desktop"),
 * this hook auto-connects to Convex and then swaps the preference to the real
 * connectionId. When the user switches away, it auto-disconnects.
 *
 * Mount this hook in a component that has access to the global sandbox preference
 * (e.g. chat.tsx).
 */
export function useDesktopSandbox({
  sandboxPreference,
  setSandboxPreference,
}: UseDesktopSandboxOptions): UseDesktopSandboxReturn {
  const [isAvailable] = useState(() => isTauriEnvironment());
  const [status, setStatus] = useState<DesktopSandboxStatus>("disconnected");
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clientRef = useRef<DesktopSandboxClient | null>(null);
  const desktopConnectionIdRef = useRef<string | null>(null);
  const getToken = useMutation(api.localSandbox.getToken);

  // Keep a ref for setSandboxPreference to avoid effect deps churn
  const setSandboxPrefRef = useRef(setSandboxPreference);
  setSandboxPrefRef.current = setSandboxPreference;

  // Auto-start when preference becomes "desktop"
  useEffect(() => {
    if (!isAvailable) return;
    if (sandboxPreference !== DESKTOP_SANDBOX_ID) return;
    if (clientRef.current?.isConnected()) return; // Already connected

    let cancelled = false;

    async function startDesktopSandbox() {
      setIsConnecting(true);
      setError(null);

      try {
        const { getDesktopSandboxClient } = await import(
          "@/lib/desktop-sandbox"
        );

        const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
        if (!convexUrl) throw new Error("NEXT_PUBLIC_CONVEX_URL not configured");

        const tokenResult = await getToken();
        if (!tokenResult?.token) throw new Error("Failed to get authentication token");

        if (cancelled) return;

        const client = getDesktopSandboxClient(convexUrl);
        clientRef.current = client;

        client.onStatusChange((newStatus) => {
          if (cancelled) return;
          setStatus(newStatus);
        });

        await client.start(tokenResult.token);

        if (cancelled) {
          await client.stop();
          return;
        }

        const connectionId = client.getConnectionId();
        desktopConnectionIdRef.current = connectionId;

        if (connectionId) {
          // Swap from the placeholder "desktop" to the real connectionId
          setSandboxPrefRef.current(connectionId);
        }
      } catch (err) {
        if (!cancelled) {
          const message =
            err instanceof Error ? err.message : "Failed to start desktop sandbox";
          setError(message);
          setStatus("error");
          // Revert to cloud on failure
          setSandboxPrefRef.current("e2b");
          console.error("[useDesktopSandbox] Start failed:", err);
        }
      } finally {
        if (!cancelled) {
          setIsConnecting(false);
        }
      }
    }

    startDesktopSandbox();

    return () => {
      cancelled = true;
    };
  }, [isAvailable, sandboxPreference, getToken]);

  // Auto-stop when preference moves away from a desktop connection
  useEffect(() => {
    if (!isAvailable) return;
    if (!clientRef.current) return;
    if (!desktopConnectionIdRef.current) return;

    // If preference is "desktop" (connecting) or matches our desktop connectionId, keep alive
    if (
      sandboxPreference === DESKTOP_SANDBOX_ID ||
      sandboxPreference === desktopConnectionIdRef.current
    ) {
      return;
    }

    // User switched away → stop the desktop sandbox
    const client = clientRef.current;
    clientRef.current = null;
    desktopConnectionIdRef.current = null;
    setStatus("disconnected");
    setError(null);
    client.stop().catch(console.error);
  }, [isAvailable, sandboxPreference]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (clientRef.current) {
        clientRef.current.stop().catch(console.error);
        clientRef.current = null;
      }
    };
  }, []);

  return {
    isAvailable,
    isConnecting,
    status,
    error,
  };
}
