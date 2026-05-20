"use client";

import { useEffect } from "react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";

export function AttributionSync() {
  const { user } = useAuth();

  useEffect(() => {
    if (!user?.id) return;
    const key = `hackerai:attribution-synced:${user.id}`;
    try {
      if (window.localStorage.getItem(key) === "true") return;
    } catch {
      // Some privacy modes disable localStorage; keep sync best-effort.
    }

    fetch("/api/analytics/attribution", { method: "POST" })
      .then((res) => {
        if (!res.ok) return;
        try {
          window.localStorage.setItem(key, "true");
        } catch {
          // Attribution already synced; cache failure should not affect the app.
        }
      })
      .catch(() => {
        // Best-effort analytics sync; never block the app shell.
      });
  }, [user?.id]);

  return null;
}
