"use client";

import { useAuth } from "@workos-inc/authkit-nextjs/components";
import type { PostHogConfig } from "posthog-js";
import { useEffect } from "react";
import { useGlobalState } from "./contexts/GlobalState";
import {
  enrichFrontendExceptionEvent,
  shouldDropExpectedFrontendException,
} from "@/lib/posthog/expected-frontend-exceptions";
import {
  captureAuthenticatedEvent,
  getPostHogClient,
  loadPostHogClient,
} from "@/lib/analytics/client";
import {
  applyAskToAgentApprovalExperiment,
  ASK_TO_AGENT_APPROVAL_FLAG_KEY,
} from "@/lib/experiments/ask-to-agent-approval";

let lastIdentifiedSignature: string | null = null;

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  const {
    agentPermissionMode,
    chatMode,
    setAgentPermissionMode,
    setChatMode,
    subscription,
    temporaryChatsEnabled,
  } = useGlobalState();
  const { user } = useAuth();
  const userId = user?.id;
  const userEmail = user?.email;
  const userFirstName = user?.firstName;
  const userLastName = user?.lastName;

  useEffect(() => {
    const posthogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    if (!posthogKey) return;

    const shouldTrack = Boolean(userId);

    if (!shouldTrack) {
      lastIdentifiedSignature = null;
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
          capture_pageview: false,
          autocapture: false,
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

        if (posthog.has_opted_out_capturing()) {
          posthog.opt_in_capturing({ captureEventName: false });
        }

        const name =
          [userFirstName, userLastName].filter(Boolean).join(" ") || userEmail;
        const identitySignature = JSON.stringify([
          userId,
          userEmail,
          name,
          subscription,
        ]);
        if (lastIdentifiedSignature !== identitySignature) {
          posthog.identify(userId!, {
            email: userEmail,
            name,
            subscription,
          });
          lastIdentifiedSignature = identitySignature;
        }

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
  }, [subscription, userEmail, userFirstName, userId, userLastName]);

  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_POSTHOG_KEY || !userId) return;

    let cancelled = false;
    let unsubscribeFeatureFlags: (() => void) | undefined;

    void loadPostHogClient()
      .then((posthog) => {
        if (cancelled || !posthog.__loaded) return;

        unsubscribeFeatureFlags = posthog.onFeatureFlags(() => {
          if (cancelled) return;

          applyAskToAgentApprovalExperiment({
            agentPermissionMode,
            captureExposure: captureAuthenticatedEvent,
            chatMode,
            enabled:
              posthog.isFeatureEnabled(ASK_TO_AGENT_APPROVAL_FLAG_KEY) === true,
            setAgentPermissionMode,
            setChatMode,
            subscription,
            temporaryChatsEnabled,
            userId,
          });
        });
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unsubscribeFeatureFlags?.();
    };
  }, [
    agentPermissionMode,
    chatMode,
    setAgentPermissionMode,
    setChatMode,
    subscription,
    temporaryChatsEnabled,
    userId,
  ]);

  return <>{children}</>;
}
