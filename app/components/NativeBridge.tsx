"use client";

import { useEffect } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import {
  isNativePlatform,
  isIOS,
  registerForPushNotifications,
  listenForAppUrlOpen,
} from "@/lib/native/capacitor-bridge";

/**
 * Mounts on native (Capacitor) platforms only. No-ops on web.
 * - Registers for APNs and stores the token in Convex.
 * - Listens for `hackerai://` deep links and routes them.
 */
export function NativeBridge() {
  const registerToken = useMutation(api.pushTokens.registerToken);

  useEffect(() => {
    if (!isNativePlatform()) return;

    let detachUrlListener: (() => void) | null = null;
    let cancelled = false;

    void (async () => {
      const token = await registerForPushNotifications();
      if (token && !cancelled) {
        try {
          await registerToken({
            token,
            platform: isIOS() ? "ios" : "android",
          });
        } catch (err) {
          console.error("[NativeBridge] Failed to store push token:", err);
        }
      }

      detachUrlListener = await listenForAppUrlOpen((url) => {
        try {
          const parsed = new URL(url);
          // Custom scheme: hackerai://path?query → route to /path?query inside the WebView
          if (parsed.protocol === "hackerai:") {
            const target = parsed.pathname + parsed.search + parsed.hash;
            if (target.startsWith("/")) {
              window.location.replace(target);
            }
          }
        } catch (err) {
          console.error("[NativeBridge] Bad deep-link URL:", url, err);
        }
      });
    })();

    return () => {
      cancelled = true;
      detachUrlListener?.();
    };
  }, [registerToken]);

  return null;
}
