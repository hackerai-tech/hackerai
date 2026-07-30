export const POSTHOG_SESSION_ID_HEADER = "x-posthog-session-id";

const SAFE_POSTHOG_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

export type AnalyticsRequestContext = {
  posthogSessionId?: string;
};

export function readAnalyticsRequestContext(
  headers: Pick<Headers, "get">,
): AnalyticsRequestContext {
  const rawSessionId = headers.get(POSTHOG_SESSION_ID_HEADER)?.trim();

  return {
    ...(rawSessionId &&
      SAFE_POSTHOG_SESSION_ID.test(rawSessionId) && {
        posthogSessionId: rawSessionId,
      }),
  };
}
