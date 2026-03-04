"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";

const BUILD_ID_URL = "/api/build-id";
const POLL_INTERVAL_MS = 60_000; // 1 minute

const handleRefresh = () => {
  window.location.reload();
};

export const useDeploymentUpdate = () => {
  const initialBuildIdRef = useRef<string | null>(null);
  const hasShownToastRef = useRef(false);

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

    // Preview: add ?preview-update-toast to the URL to see the toast
    if (
      new URLSearchParams(window.location.search).has("preview-update-toast")
    ) {
      showUpdateToast();
    }

    const checkBuildId = async () => {
      try {
        const res = await fetch(BUILD_ID_URL, {
          cache: "no-store",
          headers: { "Cache-Control": "no-cache" },
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
        // Ignore fetch errors (e.g. offline, API not ready)
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
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);
};
