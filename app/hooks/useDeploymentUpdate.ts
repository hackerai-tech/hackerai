"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";

const BUILD_ID_URL = "/api/build-id";
const POLL_INTERVAL_MS = 60_000; // 1 minute
const FETCH_TIMEOUT_MS = 10_000; // 10 seconds

const handleRefresh = () => {
  window.location.reload();
};

export const useDeploymentUpdate = () => {
  const initialBuildIdRef = useRef<string | null>(null);
  const hasShownToastRef = useRef(false);
  const isFetchingRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const showUpdateToast = () => {
    if (hasShownToastRef.current) return;
    hasShownToastRef.current = true;
    toast("Update Available!", {
      description: "Please refresh to get the latest version.",
      duration: Infinity,
      position: "top-right",
      closeButton: true,
      classNames: {
        toast:
          "!bg-black !text-white !border-black group-[.toaster]:!bg-black group-[.toaster]:!text-white",
        description: "!text-white/90",
        actionButton:
          "!bg-white !text-black hover:!bg-white/90 font-medium rounded-lg",
      },
      action: {
        label: "Refresh now",
        onClick: handleRefresh,
      },
    });
  };

  useEffect(() => {
    if (typeof window === "undefined") return;

    if (
      new URLSearchParams(window.location.search).has("preview-update-toast")
    ) {
      showUpdateToast();
    }

    const checkBuildId = async () => {
      if (isFetchingRef.current || hasShownToastRef.current) return;
      isFetchingRef.current = true;

      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      try {
        const res = await fetch(BUILD_ID_URL, {
          cache: "no-store",
          headers: { "Cache-Control": "no-cache" },
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data = (await res.json()) as { buildId: string };
        const current = data.buildId ?? "";

        if (initialBuildIdRef.current === null) {
          initialBuildIdRef.current = current;
          return;
        }

        if (
          current &&
          initialBuildIdRef.current &&
          current !== initialBuildIdRef.current
        ) {
          showUpdateToast();
        }
      } catch {
        // Ignore fetch errors (abort, offline, API not ready)
      } finally {
        clearTimeout(timeoutId);
        isFetchingRef.current = false;
      }
    };

    void checkBuildId();
    const interval = setInterval(checkBuildId, POLL_INTERVAL_MS);

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void checkBuildId();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      clearInterval(interval);
      abortControllerRef.current?.abort();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);
};
