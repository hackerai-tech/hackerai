import {
  POSTHOG_SESSION_ID_HEADER,
  readAnalyticsRequestContext,
} from "../request-context";

describe("readAnalyticsRequestContext", () => {
  it("accepts a safe PostHog session ID", () => {
    const headers = new Headers({
      [POSTHOG_SESSION_ID_HEADER]: "018f3ba2-c6e1-7f30-a6b2-4c4d8b1f90ef",
    });

    expect(readAnalyticsRequestContext(headers)).toEqual({
      posthogSessionId: "018f3ba2-c6e1-7f30-a6b2-4c4d8b1f90ef",
    });
  });

  it("drops malformed session IDs", () => {
    const headers = new Headers({
      [POSTHOG_SESSION_ID_HEADER]: "not safe/for analytics",
    });

    expect(readAnalyticsRequestContext(headers)).toEqual({});
  });
});
