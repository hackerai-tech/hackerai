"use client";

import { useAuth } from "@workos-inc/authkit-nextjs/components";
import type { PostHogConfig } from "posthog-js";
import { useEffect } from "react";
import { useGlobalState } from "./contexts/GlobalState";
import {
  enrichFrontendExceptionEvent,
  shouldDropExpectedFrontendException,
} from "@/lib/posthog/expected-frontend-exceptions";
import { getPostHogClient, loadPostHogClient } from "@/lib/analytics/client";

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  const { subscription } = useGlobalState();
  const { user } = useAuth();

  useEffect(() => {
    const posthogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    if (!posthogKey) return;

    const shouldTrack = Boolean(user);

    if (!shouldTrack) {
      const posthog = getPostHogClient();
      if (posthog?.__loaded) {
        posthog.stopSessionRecording();
        posthog.reset();
        posthog.opt_out_capturing();
      }
      return;
    }

    let cancelled = false;

    void loadPostHogClient()
      .then((posthog) => {
        if (cancelled) return;

        const config = {
          api_host:
            process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com",
          capture_pageview: false, // Disable automatic pageview capture, as we capture manually
          autocapture: false, // Disable automatic event capture, as we capture manually
          capture_exceptions: {
            capture_unhandled_errors: true,
            capture_unhandled_rejections: true,
            capture_console_errors: false,
          },
          disable_session_recording: true,
          before_send: (event) => {
            if (!event || shouldDropExpectedFrontendException(event)) {
              return null;
            }

            return enrichFrontendExceptionEvent(event);
          },
        } satisfies Partial<PostHogConfig>;

        // The singleton can be initialized before this provider mounts. Apply
        // our exception hooks in both cases so noisy browser errors are still
        // suppressed and retained errors receive diagnostic fields.
        if (!posthog.__loaded) {
          posthog.init(posthogKey, config);
        } else {
          posthog.set_config(config);
        }

        posthog.opt_in_capturing();
        posthog.identify(user!.id, {
          email: user!.email,
          name:
            [user!.firstName, user!.lastName].filter(Boolean).join(" ") ||
            user!.email,
          subscription,
        });

        if (subscription !== "free") {
          if (!posthog.sessionRecordingStarted()) {
            posthog.startSessionRecording();
          }
          return;
        }

        posthog.stopSessionRecording();
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [subscription, user]);

  return <>{children}</>;
}
