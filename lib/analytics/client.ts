"use client";

import type posthogJs from "posthog-js";
import {
  PAID_FUNNEL_EVENTS,
  createCheckoutAttemptId,
  paidFunnelProperties,
} from "@/lib/analytics/paid-funnel";

type ClientAnalyticsProperties = Record<string, unknown>;

type PostHogClient = typeof posthogJs & {
  get_session_id?: () => string;
};

let posthogClient: PostHogClient | null = null;
let posthogImportPromise: Promise<PostHogClient> | null = null;
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

export function captureAuthenticatedEvent(
  event: string,
  properties: ClientAnalyticsProperties = {},
) {
  if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return false;

  const posthog = getReadyPostHogClient();
  if (!posthog) {
    void loadPostHogClient().catch(() => {});
    return false;
  }

  try {
    posthog.capture(event, properties);
    return true;
  } catch {
    return false;
  }
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
  const dedupeKey = [
    posthog.get_distinct_id(),
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
    paidFunnelProperties(properties),
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

  const distinctId = posthog.get_distinct_id();
  const sessionId = posthog.get_session_id?.();

  return {
    ...(distinctId && { "X-POSTHOG-DISTINCT-ID": distinctId }),
    ...(sessionId && { "X-POSTHOG-SESSION-ID": sessionId }),
  };
}
