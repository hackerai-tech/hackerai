"use client";

import { clearAllDrafts } from "@/lib/utils/client-storage";

export const clientLogout = (redirectPath: string = "/logout"): void => {
  if (typeof window === "undefined") return;
  try {
    clearAllDrafts();
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
