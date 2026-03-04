"use client";

import { useEffect, useRef } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { toast } from "sonner";

const handleRefresh = () => {
  window.location.reload();
};

export const useDeploymentUpdate = () => {
  const buildId = useQuery(api.appVersion.getAppVersion);
  const initialBuildIdRef = useRef<string | null>(null);
  const hasShownToastRef = useRef(false);

  useEffect(() => {
    if (buildId === undefined || buildId === null) return;

    if (initialBuildIdRef.current === null) {
      initialBuildIdRef.current = buildId;
      return;
    }

    if (buildId !== initialBuildIdRef.current && !hasShownToastRef.current) {
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
    }
  }, [buildId]);
};
