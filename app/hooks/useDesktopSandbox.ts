"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { isTauriEnvironment } from "./useTauri";
import type {
  DesktopSandboxClient,
  DesktopSandboxStatus,
  DesktopSandboxInfo,
} from "@/lib/desktop-sandbox";

interface UseDesktopSandboxReturn {
  /** Whether the desktop sandbox feature is available (running in Tauri) */
  isAvailable: boolean;
  /** Current connection status */
  status: DesktopSandboxStatus;
  /** Full connection info */
  info: DesktopSandboxInfo | null;
  /** Start the desktop sandbox (connects to Convex and begins listening for commands) */
  start: () => Promise<void>;
  /** Stop the desktop sandbox */
  stop: () => Promise<void>;
  /** Whether the sandbox is currently connected */
  isConnected: boolean;
  /** Connection ID for use with the sandbox selector */
  connectionId: string | null;
  /** Whether start/stop is in progress */
  isLoading: boolean;
  /** Error message if connection failed */
  error: string | null;
}

/**
 * React hook to manage the desktop sandbox lifecycle.
 *
 * When running in the Tauri desktop app, this hook allows the user
 * to enable local terminal execution directly from the app without
 * needing to install @hackerai/local separately.
 */
export function useDesktopSandbox(): UseDesktopSandboxReturn {
  const [isAvailable] = useState(() => isTauriEnvironment());
  const [status, setStatus] = useState<DesktopSandboxStatus>("disconnected");
  const [info, setInfo] = useState<DesktopSandboxInfo | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const clientRef = useRef<DesktopSandboxClient | null>(null);

  const getToken = useMutation(api.localSandbox.getToken);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (clientRef.current?.isConnected()) {
        clientRef.current.stop().catch(console.error);
      }
    };
  }, []);

  const start = useCallback(async () => {
    if (!isAvailable) return;

    setIsLoading(true);
    setError(null);

    try {
      // Dynamically import to avoid loading in non-Tauri contexts
      const { getDesktopSandboxClient } = await import(
        "@/lib/desktop-sandbox"
      );

      const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
      if (!convexUrl) {
        throw new Error("NEXT_PUBLIC_CONVEX_URL not configured");
      }

      // Get or create token
      const tokenResult = await getToken();
      if (!tokenResult?.token) {
        throw new Error("Failed to get authentication token");
      }

      const client = getDesktopSandboxClient(convexUrl);
      clientRef.current = client;

      // Listen for status changes
      client.onStatusChange((newStatus) => {
        setStatus(newStatus);
        setInfo(client.info);
        setConnectionId(client.getConnectionId());
      });

      await client.start(tokenResult.token);
      setConnectionId(client.getConnectionId());
      setInfo(client.info);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start desktop sandbox";
      setError(message);
      setStatus("error");
      console.error("[useDesktopSandbox] Start failed:", err);
    } finally {
      setIsLoading(false);
    }
  }, [isAvailable, getToken]);

  const stop = useCallback(async () => {
    setIsLoading(true);

    try {
      if (clientRef.current) {
        await clientRef.current.stop();
        clientRef.current = null;
      }
      setConnectionId(null);
      setInfo(null);
      setError(null);
    } catch (err) {
      console.error("[useDesktopSandbox] Stop failed:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  return {
    isAvailable,
    status,
    info,
    start,
    stop,
    isConnected: status === "connected",
    connectionId,
    isLoading,
    error,
  };
}
