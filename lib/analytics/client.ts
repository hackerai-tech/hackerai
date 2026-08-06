"use client";

import type posthogJs from "posthog-js";
import { v5 as uuidv5 } from "uuid";
import {
  PAID_FUNNEL_EVENTS,
  UPGRADE_CTA_IMPRESSION_DEDUPE,
  createCheckoutAttemptId,
  paidFunnelProperties,
  upgradeCtaImpressionInsertId,
} from "@/lib/analytics/paid-funnel";
import { POSTHOG_SESSION_ID_HEADER } from "@/lib/analytics/request-context";

type ClientAnalyticsProperties = Record<string, unknown>;

type PostHogClient = typeof posthogJs & {
  get_session_id?: () => string;
};
type PostHogCaptureOptions = Parameters<PostHogClient["capture"]>[2];

type PendingAuthenticatedEvent = {
  userId: string;
  event: string;
  properties: ClientAnalyticsProperties;
  options?: PostHogCaptureOptions;
};

let posthogClient: PostHogClient | null = null;
let posthogImportPromise: Promise<PostHogClient> | null = null;
let authenticatedAnalyticsUserId: string | null = null;
let identifiedAnalyticsUserId: string | null = null;
const pendingAuthenticatedEvents: PendingAuthenticatedEvent[] = [];
const MAX_PENDING_AUTHENTICATED_EVENTS = 100;
const UPGRADE_IMPRESSION_STORAGE_KEY =
  "hackerai:analytics:upgrade-impressions:v1";

type UpgradeImpressionState = {
  day: string;
  keys: string[];
};

export function loadPostHogClient(): Promise<PostHogClient> {
  if (posthogClient) return Promise.resolve(posthogClient);

  posthogImportPromise ??= import("posthog-js")
    .then((mod) => {
      posthogClient = mod.default as PostHogClient;
      return posthogClient;
    })
    .catch((error) => {
      posthogImportPromise = null;
      throw error;
    });

  return posthogImportPromise;
}

export function getPostHogClient() {
  return posthogClient;
}

function getReadyPostHogClient() {
  return posthogClient?.__loaded ? posthogClient : null;
}

function captureWithPostHogClient(
  posthog: PostHogClient,
  event: string,
  properties: ClientAnalyticsProperties,
  options?: PostHogCaptureOptions,
) {
  try {
    if (options) {
      posthog.capture(event, properties, options);
    } else {
      posthog.capture(event, properties);
    }
    return true;
  } catch {
    return false;
  }
}

function queueAuthenticatedEvent(event: PendingAuthenticatedEvent) {
  const uuid = event.options?.uuid;
  if (
    uuid &&
    pendingAuthenticatedEvents.some(
      (pendingEvent) =>
        pendingEvent.userId === event.userId &&
        pendingEvent.options?.uuid === uuid,
    )
  ) {
    return;
  }

  pendingAuthenticatedEvents.push(event);
  if (pendingAuthenticatedEvents.length > MAX_PENDING_AUTHENTICATED_EVENTS) {
    pendingAuthenticatedEvents.shift();
  }
}

export function setAuthenticatedAnalyticsUserId(userId: string | null) {
  if (authenticatedAnalyticsUserId === userId) return;
  authenticatedAnalyticsUserId = userId;
  identifiedAnalyticsUserId = null;
  pendingAuthenticatedEvents.splice(0);
}

export function flushPendingAuthenticatedEvents(userId: string) {
  if (
    authenticatedAnalyticsUserId !== userId ||
    identifiedAnalyticsUserId !== userId
  ) {
    return false;
  }

  const posthog = getReadyPostHogClient();
  if (!posthog || pendingAuthenticatedEvents.length === 0) return false;

  const pendingEvents = pendingAuthenticatedEvents.splice(0);
  for (const pendingEvent of pendingEvents) {
    if (pendingEvent.userId !== userId) continue;
    if (
      !captureWithPostHogClient(
        posthog,
        pendingEvent.event,
        pendingEvent.properties,
        pendingEvent.options,
      )
    ) {
      queueAuthenticatedEvent(pendingEvent);
    }
  }
  return pendingAuthenticatedEvents.length === 0;
}

export function confirmAuthenticatedAnalyticsUserId(userId: string) {
  if (authenticatedAnalyticsUserId !== userId) return false;
  identifiedAnalyticsUserId = userId;
  return flushPendingAuthenticatedEvents(userId);
}

export function captureAuthenticatedEvent(
  event: string,
  properties: ClientAnalyticsProperties = {},
  options?: PostHogCaptureOptions,
) {
  if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return false;

  const posthog = getReadyPostHogClient();
  if (!posthog) {
    void loadPostHogClient().catch(() => {});
    return false;
  }

  return captureWithPostHogClient(posthog, event, properties, options);
}

export function captureMessageFeedback({
  messageId,
  feedbackType,
  previousFeedbackType,
}: {
  messageId: string;
  feedbackType: "positive" | "negative";
  previousFeedbackType?: "positive" | "negative";
}) {
  const event = "message_feedback_submitted";
  const properties = {
    message_id: messageId,
    feedback_type: feedbackType,
    is_initial_feedback: previousFeedbackType === undefined,
    ...(previousFeedbackType && {
      previous_feedback_type: previousFeedbackType,
    }),
    feedback_event_version: 1,
  };
  const options = {
    uuid: uuidv5(
      [event, messageId, previousFeedbackType ?? "none", feedbackType].join(
        ":",
      ),
      uuidv5.URL,
    ),
  };

  const userId = authenticatedAnalyticsUserId;
  if (!userId) return false;

  if (
    identifiedAnalyticsUserId === userId &&
    captureAuthenticatedEvent(event, properties, options)
  ) {
    return true;
  }
  if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return false;

  queueAuthenticatedEvent({ userId, event, properties, options });
  void loadPostHogClient()
    .then(() => flushPendingAuthenticatedEvents(userId))
    .catch(() => {});
  return true;
}

export function addAuthenticatedExceptionStep(
  message: string,
  properties: ClientAnalyticsProperties = {},
) {
  if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return false;

  const posthog = getReadyPostHogClient();
  if (!posthog) {
    void loadPostHogClient().catch(() => {});
    return false;
  }

  try {
    posthog.addExceptionStep(message, properties);
    return true;
  } catch {
    return false;
  }
}

type CtaAnalyticsProperties = ClientAnalyticsProperties & {
  surface: string;
  source?: string;
};

export function captureUpgradeCtaImpression(
  properties: CtaAnalyticsProperties,
) {
  const posthog = getReadyPostHogClient();
  if (!posthog) {
    void loadPostHogClient().catch(() => {});
    return false;
  }

  const day = new Date().toISOString().slice(0, 10);
  const distinctId = posthog.get_distinct_id();
  const dedupeKey = [
    distinctId,
    properties.surface,
    properties.source ?? "",
  ].join(":");

  let state: UpgradeImpressionState = { day, keys: [] };
  try {
    const stored = window.localStorage.getItem(UPGRADE_IMPRESSION_STORAGE_KEY);
    const parsed = stored
      ? (JSON.parse(stored) as UpgradeImpressionState)
      : null;
    if (
      parsed?.day === day &&
      Array.isArray(parsed.keys) &&
      parsed.keys.every((key) => typeof key === "string")
    ) {
      state = parsed;
    }
    if (state.keys.includes(dedupeKey)) return false;
  } catch {
    // Storage can be unavailable in privacy-restricted browsers. Capture the
    // event normally rather than dropping a legitimate impression.
  }

  const captured = captureAuthenticatedEvent(
    PAID_FUNNEL_EVENTS.upgradeCtaImpressed,
    paidFunnelProperties({
      ...properties,
      impression_dedupe_scope: UPGRADE_CTA_IMPRESSION_DEDUPE.scope,
      impression_dedupe_version: UPGRADE_CTA_IMPRESSION_DEDUPE.version,
      impression_utc_day: day,
    }),
    {
      uuid: uuidv5(
        upgradeCtaImpressionInsertId({
          distinctId,
          surface: properties.surface,
          source: properties.source,
          utcDay: day,
        }),
        uuidv5.URL,
      ),
    },
  );
  if (!captured) return false;

  try {
    window.localStorage.setItem(
      UPGRADE_IMPRESSION_STORAGE_KEY,
      JSON.stringify({ day, keys: [...state.keys, dedupeKey].slice(-100) }),
    );
  } catch {
    // Best-effort dedupe only.
  }
  return true;
}

export function captureUpgradeCtaClick(properties: CtaAnalyticsProperties) {
  return captureAuthenticatedEvent(
    PAID_FUNNEL_EVENTS.upgradeCtaClicked,
    paidFunnelProperties(properties),
  );
}

export function captureAddCreditCtaImpression(
  properties: CtaAnalyticsProperties,
) {
  return captureAuthenticatedEvent(
    PAID_FUNNEL_EVENTS.addCreditCtaImpressed,
    paidFunnelProperties(properties),
  );
}

export function captureAddCreditCtaClick(properties: CtaAnalyticsProperties) {
  return captureAuthenticatedEvent(
    PAID_FUNNEL_EVENTS.addCreditCtaClicked,
    paidFunnelProperties(properties),
  );
}

export function capturePaidDailyFreeAllowanceImpression(
  properties: CtaAnalyticsProperties,
) {
  return captureAuthenticatedEvent(
    PAID_FUNNEL_EVENTS.paidDailyFreeAllowanceImpressed,
    paidFunnelProperties(properties),
  );
}

export function capturePaidDailyFreeAllowanceClick(
  properties: CtaAnalyticsProperties,
) {
  return captureAuthenticatedEvent(
    PAID_FUNNEL_EVENTS.paidDailyFreeAllowanceClicked,
    paidFunnelProperties(properties),
  );
}

export function newCheckoutAttemptId() {
  return createCheckoutAttemptId();
}

export function getPostHogRequestHeaders(): HeadersInit {
  const posthog = getReadyPostHogClient();
  if (!posthog) return {};

  const sessionId = posthog.get_session_id?.();

  return {
    ...(sessionId && { [POSTHOG_SESSION_ID_HEADER]: sessionId }),
  };
}
