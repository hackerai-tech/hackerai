"use client";

import posthog from "posthog-js";
import { PostHogProvider as PHProvider } from "posthog-js/react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { useEffect } from "react";
import { useGlobalState } from "./contexts/GlobalState";

const IGNORED_CONVEX_EXCEPTION_MESSAGES = [
  "Unauthorized: User not authenticated",
  "Invalid arguments provided",
];

function getExceptionMessages(event: {
  properties?: Record<string, unknown>;
}): string[] {
  const properties = event.properties ?? {};
  const messages: string[] = [];

  if (typeof properties.$exception_message === "string") {
    messages.push(properties.$exception_message);
  }

  if (Array.isArray(properties.$exception_list)) {
    for (const exception of properties.$exception_list) {
      if (
        exception &&
        typeof exception === "object" &&
        "value" in exception &&
        typeof exception.value === "string"
      ) {
        messages.push(exception.value);
      }
    }
  }

  return messages;
}

function shouldDropExpectedConvexException(event: {
  event?: string;
  properties?: Record<string, unknown>;
}) {
  if (event.event !== "$exception") {
    return false;
  }

  return getExceptionMessages(event).some((message) =>
    IGNORED_CONVEX_EXCEPTION_MESSAGES.some((ignoredMessage) =>
      message.includes(ignoredMessage),
    ),
  );
}

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  const { subscription } = useGlobalState();
  const { user } = useAuth();

  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return;

    // Determine if we should track this user:
    // - By default (env not set): only track paid users (pro, ultra, team)
    // - If NEXT_PUBLIC_POSTHOG_TRACK_FREE_USERS=true: only track free users
    const trackFreeUsers =
      process.env.NEXT_PUBLIC_POSTHOG_TRACK_FREE_USERS === "true";
    const isPaidUser = subscription !== "free";

    const shouldTrack =
      Boolean(user) && (trackFreeUsers ? !isPaidUser : isPaidUser);

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
