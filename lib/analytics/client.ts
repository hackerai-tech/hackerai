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

type CtaAnalyticsProperties = ClientAnalyticsProperties & {
  surface: string;
  source?: string;
};

export function captureUpgradeCtaImpression(
  properties: CtaAnalyticsProperties,
) {
  return captureAuthenticatedEvent(
    PAID_FUNNEL_EVENTS.upgradeCtaImpressed,
    paidFunnelProperties(properties),
  );
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
