"use client";

import posthog from "posthog-js";

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
