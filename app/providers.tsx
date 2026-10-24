"use client";

import { useAuth } from "@workos-inc/authkit-nextjs/components";
import type { PostHogConfig } from "posthog-js";
import { useEffect, useRef } from "react";
import { useGlobalState } from "./contexts/GlobalState";
import {
  enrichFrontendExceptionEvent,
  sanitizeFrontendExceptionUrlProperties,
  shouldDropExpectedFrontendException,
} from "@/lib/posthog/expected-frontend-exceptions";
import {
  confirmAuthenticatedAnalyticsUserId,
  getPostHogClient,
  loadPostHogClient,
  setAuthenticatedAnalyticsUserId,
} from "@/lib/analytics/client";
import {
  createPostHogIdentitySignature,
  POSTHOG_IDENTITY_SIGNATURE_STORAGE_KEY,
} from "@/lib/analytics/identity";
import {
  firstTouchPersonProperties,
  type FirstTouchAttribution,
} from "@/lib/analytics/acquisition";

import { sanitizeAgentCancellationEvent } from "@/lib/analytics/agent-cancellation-privacy";
import { sanitizeContextFeedbackEvent } from "@/lib/analytics/context-feedback-privacy";
import { sanitizeDesktopAckEvent } from "@/lib/analytics/desktop-ack-privacy";
import { sanitizeChatPerformanceEvent } from "@/lib/analytics/chat-performance-privacy";
import {
  captureXReferralVisit,
  clearXReferralDedupe,
  isXReferralLanding,
  sanitizeXReferralEvent,
  X_REFERRAL_EVENT,
} from "@/lib/analytics/x-referral";

let lastIdentifiedSignature: string | null = null;

function isEnglishLocale(locale: string | null | undefined) {
  const normalizedLocale = locale?.trim().replaceAll("_", "-");
  if (!normalizedLocale) return false;

  try {
    return new Intl.Locale(normalizedLocale).language === "en";
  } catch {
    return false;
  }
}

export function PostHogProvider({
  analyticsAllowed,
  children,
  consentRequired = false,
  firstTouchAttribution = null,
}: {
  analyticsAllowed: boolean;
  children: React.ReactNode;
  consentRequired?: boolean;
  firstTouchAttribution?: FirstTouchAttribution | null;
}) {
  const { subscription } = useGlobalState();
  const { user } = useAuth();
  const userId = user?.id;
  const userEmail = user?.email;
  const userFirstName = user?.firstName;
  const userLastName = user?.lastName;
  const userLocale = user?.locale;
  const referralHandled = useRef(false);

  useEffect(() => {
    const posthogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    if (!posthogKey) return;

    const shouldTrack = Boolean(userId) && analyticsAllowed;
    setAuthenticatedAnalyticsUserId(shouldTrack ? userId! : null);

    if (!shouldTrack) {
      lastIdentifiedSignature = null;
      try {
        window.localStorage.removeItem(POSTHOG_IDENTITY_SIGNATURE_STORAGE_KEY);
      } catch {
        // Storage can be unavailable in privacy-restricted browsers.
      }
      const posthog = getPostHogClient();
      if (posthog?.__loaded) {
        posthog.stopSessionRecording();
        // Preserve an anonymous X visitor through navigation and signup. Only
        // reset an identified account (logout) or a withdrawn consent choice.
        posthog.set_config({
          before_send: () => null,
          capture_exceptions: false,
        });
        if (!analyticsAllowed || posthog.get_property("$user_id")) {
          posthog.reset();
        }
        if (!analyticsAllowed) posthog.opt_out_capturing();
      }
      if (!analyticsAllowed) clearXReferralDedupe();
      if (!analyticsAllowed || referralHandled.current || !isXReferralLanding())
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
          capture_pageleave: false,
          autocapture: false,
          advanced_disable_feature_flags: true,
          person_profiles: "identified_only",
          save_referrer: Boolean(userId),
          save_campaign_params: Boolean(userId),
          disable_surveys: !userId,
          capture_exceptions: userId
            ? {
                capture_unhandled_errors: true,
                capture_unhandled_rejections: true,
                capture_console_errors: false,
              }
            : false,
          disable_session_recording: true,
          before_send: (event) => {
            if (!event) {
              return null;
            }
            if (event.event === X_REFERRAL_EVENT) {
              return sanitizeXReferralEvent(event);
            }
            // Anonymous visitors emit only the bounded referral event. Keep
            // incidental component events and SDK autocapture out of the stream.
            if (!userId) return null;

            const sanitizedEvent = sanitizeContextFeedbackEvent(
              sanitizeChatPerformanceEvent(
                sanitizeDesktopAckEvent(
                  sanitizeAgentCancellationEvent(
                    sanitizeFrontendExceptionUrlProperties(event),
                  ),
                ),
              ),
            );
            if (shouldDropExpectedFrontendException(sanitizedEvent)) {
              return null;
            }

            return enrichFrontendExceptionEvent(sanitizedEvent);
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

        // A freshly initialized SDK can restore the last signed-in account
        // from its cookie after logout. Never attach a new visitor to it.
        if (!userId && posthog.get_property("$user_id")) posthog.reset();

        if (posthog.has_opted_out_capturing()) {
          posthog.opt_in_capturing({ captureEventName: false });
        }

        if (!userId) {
          posthog.stopSessionRecording();
          if (!referralHandled.current) {
            referralHandled.current = captureXReferralVisit(posthog);
          }
          return;
        }

        const name =
          [userFirstName, userLastName].filter(Boolean).join(" ") || userEmail;
        const identitySignature = createPostHogIdentitySignature({
          userId: userId!,
          email: userEmail,
          name,
          subscription,
          firstTouchAttribution,
        });
        if (lastIdentifiedSignature !== identitySignature) {
          let persistedIdentitySignature: string | null = null;
          try {
            persistedIdentitySignature = window.localStorage.getItem(
              POSTHOG_IDENTITY_SIGNATURE_STORAGE_KEY,
            );
          } catch {
            // Storage can be unavailable in privacy-restricted browsers.
          }

          const shouldUpdatePersonProperties =
            persistedIdentitySignature !== identitySignature;
          const personProperties = shouldUpdatePersonProperties
            ? {
                email: userEmail,
                name,
                subscription,
              }
            : undefined;
          if (shouldUpdatePersonProperties && firstTouchAttribution) {
            posthog.identify(
              userId!,
              personProperties,
              firstTouchPersonProperties(firstTouchAttribution),
            );
          } else {
            posthog.identify(userId!, personProperties);
          }
          lastIdentifiedSignature = identitySignature;

          if (shouldUpdatePersonProperties) {
            try {
              window.localStorage.setItem(
                POSTHOG_IDENTITY_SIGNATURE_STORAGE_KEY,
                identitySignature,
              );
            } catch {
              // Best-effort cross-load deduplication only.
            }
          }
        }

        confirmAuthenticatedAnalyticsUserId(userId!);
        if (!referralHandled.current) {
          referralHandled.current = captureXReferralVisit(posthog);
        }

        const replayLocale =
          userLocale == null ? window.navigator.language : userLocale;
        const shouldRecordSession =
          !consentRequired &&
          subscription !== "free" &&
          isEnglishLocale(replayLocale);

        if (shouldRecordSession) {
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
  }, [
    analyticsAllowed,
    consentRequired,
    firstTouchAttribution,
    subscription,
    userEmail,
    userFirstName,
    userId,
    userLastName,
    userLocale,
  ]);

  return children;
}
