import {
  ANALYTICS_CONTEXT_VERSION_HEADER,
  HAC45_AGENT_ONLY_HEADER,
  POSTHOG_SESSION_ID_HEADER,
  readAnalyticsRequestContext,
} from "../request-context";

describe("readAnalyticsRequestContext", () => {
  it("accepts the versioned experiment state and a safe PostHog session ID", () => {
    const headers = new Headers({
      [ANALYTICS_CONTEXT_VERSION_HEADER]: "1",
      [HAC45_AGENT_ONLY_HEADER]: "active",
      [POSTHOG_SESSION_ID_HEADER]: "018f3ba2-c6e1-7f30-a6b2-4c4d8b1f90ef",
    });

    expect(readAnalyticsRequestContext(headers)).toEqual({
      analyticsContextVersion: 1,
      hac45AgentOnlyClientActive: true,
      posthogSessionId: "018f3ba2-c6e1-7f30-a6b2-4c4d8b1f90ef",
    });
  });

  it("keeps an explicit inactive state while dropping malformed values", () => {
    const headers = new Headers({
      [ANALYTICS_CONTEXT_VERSION_HEADER]: "2",
      [HAC45_AGENT_ONLY_HEADER]: "inactive",
      [POSTHOG_SESSION_ID_HEADER]: "not safe/for analytics",
    });

    expect(readAnalyticsRequestContext(headers)).toEqual({
      hac45AgentOnlyClientActive: false,
    });
  });
});
