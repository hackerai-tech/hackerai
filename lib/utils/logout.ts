"use client";

import { clearSharedToken } from "@/lib/auth/shared-token";
import {
  clearAllDrafts,
  clearSelectedModelFromStorage,
  clearSidebarTaskLastVisitedAt,
} from "@/lib/utils/client-storage";
import { shutdownIntercomSession } from "@/lib/intercom/client";

export const clientLogout = (redirectPath: string = "/logout"): void => {
  if (typeof window === "undefined") return;
  try {
    shutdownIntercomSession();
    clearAllDrafts();
    clearSelectedModelFromStorage();
    clearSidebarTaskLastVisitedAt();
    clearSharedToken();
  } catch {
    // ignore
  } finally {
    try {
      window.location.href = redirectPath;
    } catch {
      // ignore
    }
  }
};
