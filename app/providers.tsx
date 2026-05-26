"use client";

import posthog from "posthog-js";
import { PostHogProvider as PHProvider } from "posthog-js/react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { useEffect } from "react";
import { useGlobalState } from "./contexts/GlobalState";
import { shouldDropExpectedConvexException } from "@/lib/posthog/expected-convex-errors";

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  const { subscription } = useGlobalState();
  const { user } = useAuth();

  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return;

    const shouldTrack = Boolean(user);

    if (!shouldTrack) {
      if (posthog.__loaded) {
        posthog.reset();
        posthog.opt_out_capturing();
      }
      return;
    }

    // Initialize PostHog if not already initialized
    if (!posthog.__loaded) {
      posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY, {
        api_host: `${process.env.NEXT_PUBLIC_POSTHOG_HOST}`,
        capture_pageview: false, // Disable automatic pageview capture, as we capture manually
        autocapture: false, // Disable automatic event capture, as we capture manually
        before_send: (event) => {
          if (!event || shouldDropExpectedConvexException(event)) {
            return null;
          }

          return event;
        },
      });
    }

    posthog.opt_in_capturing();
    posthog.identify(user!.id, {
      email: user!.email,
      name:
        [user!.firstName, user!.lastName].filter(Boolean).join(" ") ||
        user!.email,
      subscription,
    });
  }, [subscription, user]);

  return <PHProvider client={posthog}>{children}</PHProvider>;
}
