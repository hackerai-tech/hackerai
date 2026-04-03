"use client";

import { clearSharedToken } from "@/lib/auth/shared-token";
import {
  clearAllDrafts,
  clearSelectedModelFromStorage,
} from "@/lib/utils/client-storage";

export const clientLogout = (redirectPath: string = "/logout"): void => {
  if (typeof window === "undefined") return;
  try {
    clearAllDrafts();
    clearSelectedModelFromStorage();
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
