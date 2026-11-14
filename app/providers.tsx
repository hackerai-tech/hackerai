"use client";

import { useAuth } from "@workos-inc/authkit-nextjs/components";
import type { PostHogConfig } from "posthog-js";
import { isAbuseTelemetry, isAbuseReportingPath } from "@/lib/abuse/privacy";
import { usePathname } from "next/navigation";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useGlobalState } from "./contexts/GlobalState";
import { startUnhandledRejectionDiagnostics } from "@/lib/posthog/unhandled-rejection-diagnostics";
import { clearMessageNavigatorDiagnostics } from "@/lib/posthog/message-navigator-diagnostics";
import {
  enrichFrontendExceptionEvent,
  sanitizeFrontendExceptionUrlProperties,
  shouldDropExpectedFrontendException,
} from "@/lib/posthog/expected-frontend-exceptions";
import {
  confirmAuthenticatedAnalyticsUserId,
  getIdentifiedAnalyticsUserId,
  getPermittedAnalyticsUserId,
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
import { sanitizeDiffViewEvent } from "@/lib/analytics/diff-view-privacy";
import { sanitizeContextFeedbackEvent } from "@/lib/analytics/context-feedback-privacy";
import { sanitizeDesktopAckEvent } from "@/lib/analytics/desktop-ack-privacy";
import {
  applyDesktopRuntimeIdentity,
  startDesktopRuntimeIdentityLookup,
} from "@/lib/analytics/desktop-runtime-identity";
import { sanitizeChatPerformanceEvent } from "@/lib/analytics/chat-performance-privacy";
import { sanitizeServerActionClientContextEvent } from "@/lib/analytics/server-action-privacy";
import { sanitizeFileActionAuthDiagnosticEvent } from "@/lib/analytics/file-auth-diagnostics";
import {
  captureXReferralVisit,
  clearXReferralDedupe,
  isXReferralLanding,
  sanitizeXReferralEvent,
  X_REFERRAL_EVENT,
} from "@/lib/analytics/x-referral";

import {
  captureInfluencerVisit,
  clearInfluencerVisit,
  pendingInfluencerVisit,
  sanitizeInfluencerVisit,
} from "@/lib/influencers/browser-visits";
import { INFLUENCER_VISIT_EVENT } from "@/lib/influencers/visit-handoff";

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

/** Configure consent-gated analytics and clean up per-account observers. */
export function PostHogProvider({
  analyticsAllowed,
  children,
  consentRequired = false,
  consentDeclined = false,
  firstTouchAttribution = null,
}: {
  analyticsAllowed: boolean;
  children: React.ReactNode;
  consentRequired?: boolean;
  consentDeclined?: boolean;
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
  const pathname = usePathname();
  const privatePage = isAbuseReportingPath(pathname ?? "");
  const privateReplaySession = useRef(false);
  // Latest committed owner for the server action, file action and navigator
  // diagnostics. A
  // previously installed before_send can run after a commit that withdraws
  // consent, signs out, switches account or enters a private page, but before
  // the passive effect below resets analytics identity.
  const serverActionDiagnosticOwner = useRef<string | null>(null);

  useLayoutEffect(() => {
    serverActionDiagnosticOwner.current =
      analyticsAllowed && !privatePage && userId ? userId : null;
    return () => {
      serverActionDiagnosticOwner.current = null;
      // A later return to the same owner must not revive an older observation.
      clearMessageNavigatorDiagnostics();
    };
  }, [analyticsAllowed, privatePage, userId]);

  useEffect(() => {
    const posthogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    if (!posthogKey) return;
    // Local-only and bounded: resolve before the SDK can report startup errors.
    void startDesktopRuntimeIdentityLookup();

    const replayBlockKey = "hackerai_abuse_replay_blocked";
    const blockReplay = () => {
      privateReplaySession.current = true;
      try {
        window.sessionStorage.setItem(replayBlockKey, "1");
      } catch {
        /* In-memory protection remains. */
      }
    };
    try {
      privateReplaySession.current ||=
        window.sessionStorage.getItem(replayBlockKey) === "1";
    } catch {
      /* Storage may be unavailable. */
    }
    if (privatePage) {
      blockReplay();
      setAuthenticatedAnalyticsUserId(null);
      const loaded = getPostHogClient();
      loaded?.stopSessionRecording();
      loaded?.set_config({
        disable_session_recording: true,
        capture_exceptions: false,
        before_send: () => null,
      });
      return;
    }

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
      if (!analyticsAllowed) {
        clearXReferralDedupe();
        if (consentDeclined) clearInfluencerVisit();
      }
      if (
        !analyticsAllowed ||
        (!pendingInfluencerVisit() &&
          (referralHandled.current || !isXReferralLanding()))
      )
        return;
    }

    let cancelled = false;
    let stopRejectionDiagnostics: (() => void) | undefined;

    void loadPostHogClient()
      .then(async (posthog) => {
        await startDesktopRuntimeIdentityLookup();
        if (
          cancelled ||
          (userId && serverActionDiagnosticOwner.current !== userId)
        )
          return;

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
            if (isAbuseTelemetry(window.location.pathname, event.properties)) {
              blockReplay();
              return null;
            }
            // rrweb snapshots can flush after navigation without an originating
            // URL. Keep replay off for the rest of this tab session, including reload.
            if (event.event === "$snapshot" && privateReplaySession.current)
              return null;
            if (event.event === INFLUENCER_VISIT_EVENT)
              return sanitizeInfluencerVisit(event);
            if (event.event === X_REFERRAL_EVENT) {
              return sanitizeXReferralEvent(event);
            }
            // Anonymous visitors emit only the bounded referral event. Keep
            // incidental component events and SDK autocapture out of the stream.
            if (!userId) return null;

            const committedDiagnosticOwner = () => {
              const owner = getPermittedAnalyticsUserId();
              return owner === userId &&
                owner === serverActionDiagnosticOwner.current &&
                getIdentifiedAnalyticsUserId() === owner
                ? owner
                : null;
            };
            const committedDiagnosticExpectation = () => ({
              owner: committedDiagnosticOwner(),
              token: posthogKey,
            });
            const sanitizedEvent = sanitizeFileActionAuthDiagnosticEvent(
              sanitizeServerActionClientContextEvent(
                sanitizeContextFeedbackEvent(
                  sanitizeChatPerformanceEvent(
                    sanitizeDesktopAckEvent(
                      sanitizeAgentCancellationEvent(
                        sanitizeDiffViewEvent(
                          sanitizeFrontendExceptionUrlProperties(event),
                        ),
                      ),
                    ),
                  ),
                ),
                committedDiagnosticExpectation,
              ),
              committedDiagnosticExpectation,
            );
            if (
              !sanitizedEvent ||
              shouldDropExpectedFrontendException(sanitizedEvent)
            ) {
              return null;
            }

            let navigatorDiagnosticOwner: string | null = null;
            if (sanitizedEvent.event === "$exception") {
              try {
                navigatorDiagnosticOwner = committedDiagnosticOwner();
              } catch {
                // Fail closed; the exception itself is still retained.
              }
            }
            // Last, so no event-specific projection can strip Desktop identity.
            return applyDesktopRuntimeIdentity(
              enrichFrontendExceptionEvent(sanitizedEvent, {
                navigatorDiagnosticOwner,
              }),
            );
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

        captureInfluencerVisit(posthog);

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
        stopRejectionDiagnostics = startUnhandledRejectionDiagnostics();
        if (!referralHandled.current) {
          referralHandled.current = captureXReferralVisit(posthog);
        }

        const replayLocale =
          userLocale == null ? window.navigator.language : userLocale;
        const shouldRecordSession =
          !privateReplaySession.current &&
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
      stopRejectionDiagnostics?.();
    };
  }, [
    analyticsAllowed,
    privatePage,
    consentRequired,
    consentDeclined,
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
