"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChatSDKError } from "@/lib/errors";

const RECONNECT_DELAYS_MS = [500, 1500, 4500];

export function isNetworkStreamError(error: unknown): boolean {
  if (error instanceof ChatSDKError) return error.type === "offline";
  if (!(error instanceof Error)) return false;
  // User-initiated stops surface as AbortError — never auto-reconnect those.
  if (error.name === "AbortError") return false;
  if (error instanceof TypeError) return true;
  const msg = error.message.toLowerCase();
  return (
    msg.includes("failed to fetch") ||
    msg.includes("network") ||
    msg.includes("load failed")
  );
}

interface UseStreamReconnectParams {
  resumeStream: () => void;
}

export function useStreamReconnect({ resumeStream }: UseStreamReconnectParams) {
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const attemptRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPending = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    clearPending();
    attemptRef.current = 0;
    setIsReconnecting(false);
    setExhausted(false);
  }, [clearPending]);

  const tryReconnect = useCallback((): boolean => {
    clearPending();
    if (attemptRef.current >= RECONNECT_DELAYS_MS.length) {
      setIsReconnecting(false);
      setExhausted(true);
      return false;
    }
    const delay = RECONNECT_DELAYS_MS[attemptRef.current];
    attemptRef.current += 1;
    setIsReconnecting(true);
    setExhausted(false);

    const schedule = () => {
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        resumeStream();
      }, delay);
    };

    // If offline, wait for the browser to come back online before attempting.
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      const onOnline = () => {
        window.removeEventListener("online", onOnline);
        schedule();
      };
      window.addEventListener("online", onOnline);
    } else {
      schedule();
    }

    return true;
  }, [clearPending, resumeStream]);

  useEffect(() => clearPending, [clearPending]);

  return { isReconnecting, exhausted, tryReconnect, reset };
}
