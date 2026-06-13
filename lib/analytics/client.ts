"use client";

import posthog from "posthog-js";
import {
  PAID_FUNNEL_EVENTS,
  createCheckoutAttemptId,
  paidFunnelProperties,
} from "@/lib/analytics/paid-funnel";

type ClientAnalyticsProperties = Record<string, unknown>;

type PostHogWithSession = typeof posthog & {
  get_session_id?: () => string;
};

function isPostHogReady() {
  return Boolean(posthog.__loaded);
}

export function captureAuthenticatedEvent(
  event: string,
  properties: ClientAnalyticsProperties = {},
) {
  if (!isPostHogReady()) return false;

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
  if (!isPostHogReady()) return {};

  const posthogWithSession = posthog as PostHogWithSession;
  const distinctId = posthog.get_distinct_id();
  const sessionId = posthogWithSession.get_session_id?.();

  return {
    ...(distinctId && { "X-POSTHOG-DISTINCT-ID": distinctId }),
    ...(sessionId && { "X-POSTHOG-SESSION-ID": sessionId }),
  };
}
