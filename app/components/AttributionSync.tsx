"use client";

import { useEffect } from "react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";

export function AttributionSync() {
  const { user } = useAuth();

  useEffect(() => {
    if (!user?.id) return;
    const key = `hackerai:attribution-synced:${user.id}`;
    if (window.localStorage.getItem(key) === "true") return;

    fetch("/api/analytics/attribution", { method: "POST" })
      .then((res) => {
        if (res.ok) window.localStorage.setItem(key, "true");
      })
      .catch(() => {
        // Best-effort analytics sync; never block the app shell.
      });
  }, [user?.id]);

  return null;
}
