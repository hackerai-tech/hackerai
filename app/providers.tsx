"use client";

import posthog from "posthog-js";
import { PostHogProvider as PHProvider } from "posthog-js/react";
import { useEffect } from "react";
import { useGlobalState } from "./contexts/GlobalState";

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  const { subscription } = useGlobalState();

  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return;

    // Determine if we should track this user:
    // - By default (env not set): only track paid users (pro, ultra, team)
    // - If NEXT_PUBLIC_POSTHOG_TRACK_FREE_USERS=true: only track free users
    const trackFreeUsers =
      process.env.NEXT_PUBLIC_POSTHOG_TRACK_FREE_USERS === "true";
    const isPaidUser = subscription !== "free";

    const shouldTrack = trackFreeUsers ? !isPaidUser : isPaidUser;

    if (!shouldTrack) {
      return;
    }

    // Initialize PostHog if not already initialized
    if (!posthog.__loaded) {
      posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY, {
        api_host: `${process.env.NEXT_PUBLIC_POSTHOG_HOST}`,
        capture_pageview: false, // Disable automatic pageview capture, as we capture manually
        autocapture: false, // Disable automatic event capture, as we capture manually
      });
    }
  }, [subscription]);

  return <PHProvider client={posthog}>{children}</PHProvider>;
}
