"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { useIsMobile } from "@/hooks/use-mobile";
import { useGlobalState } from "@/app/contexts/GlobalState";

type StartNewChatOptions = {
  projectId?: string;
  useDesktop?: boolean;
};

export function useStartNewChat() {
  const router = useRouter();
  const isMobile = useIsMobile();
  const {
    closeSidebar,
    initializeNewChat,
    setActiveProjectId,
    setChatSidebarOpen,
    setSandboxPreference,
  } = useGlobalState();

  return useCallback(
    ({ projectId, useDesktop = false }: StartNewChatOptions = {}) => {
      closeSidebar();
      if (isMobile) setChatSidebarOpen(false);

      initializeNewChat();
      setActiveProjectId(projectId ?? null);
      if (useDesktop) setSandboxPreference("desktop");

      router.push(
        projectId ? `/?project=${encodeURIComponent(projectId)}` : "/",
      );
    },
    [
      closeSidebar,
      initializeNewChat,
      isMobile,
      router,
      setActiveProjectId,
      setChatSidebarOpen,
      setSandboxPreference,
    ],
  );
}
