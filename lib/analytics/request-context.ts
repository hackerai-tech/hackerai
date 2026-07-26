export const POSTHOG_SESSION_ID_HEADER = "x-posthog-session-id";
export const ANALYTICS_CONTEXT_VERSION_HEADER =
  "x-hackerai-analytics-context-version";
export const HAC45_AGENT_ONLY_HEADER = "x-hackerai-hac45-agent-only";

export const ANALYTICS_CONTEXT_VERSION = 1;

const SAFE_POSTHOG_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

export type AnalyticsRequestContext = {
  analyticsContextVersion?: number;
  hac45AgentOnlyClientActive?: boolean;
  posthogSessionId?: string;
};

export function readAnalyticsRequestContext(
  headers: Pick<Headers, "get">,
): AnalyticsRequestContext {
  const rawSessionId = headers.get(POSTHOG_SESSION_ID_HEADER)?.trim();
  const rawContextVersion = headers.get(ANALYTICS_CONTEXT_VERSION_HEADER);
  const rawHac45AgentOnly = headers.get(HAC45_AGENT_ONLY_HEADER);

  return {
    ...(rawSessionId &&
      SAFE_POSTHOG_SESSION_ID.test(rawSessionId) && {
        posthogSessionId: rawSessionId,
      }),
    ...(rawContextVersion === String(ANALYTICS_CONTEXT_VERSION) && {
      analyticsContextVersion: ANALYTICS_CONTEXT_VERSION,
    }),
    ...(rawHac45AgentOnly === "active" && {
      hac45AgentOnlyClientActive: true,
    }),
    ...(rawHac45AgentOnly === "inactive" && {
      hac45AgentOnlyClientActive: false,
    }),
  };
}
