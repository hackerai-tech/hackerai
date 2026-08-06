import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

const mockCapture = jest.fn();
const mockPostHog = {
  __loaded: true,
  capture: mockCapture,
  get_distinct_id: jest.fn(() => "user_123"),
  get_session_id: jest.fn(() => "session_123"),
};

jest.mock("posthog-js", () => ({
  __esModule: true,
  default: mockPostHog,
}));

const {
  captureMessageFeedback,
  captureUpgradeCtaImpression,
  confirmAuthenticatedAnalyticsUserId,
  flushPendingAuthenticatedEvents,
  getPostHogRequestHeaders,
  loadPostHogClient,
  setAuthenticatedAnalyticsUserId,
} = require("../client") as typeof import("../client");

describe("client analytics", () => {
  beforeAll(async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    await loadPostHogClient();
  });

  beforeEach(() => {
    window.localStorage.clear();
    mockPostHog.__loaded = true;
    setAuthenticatedAnalyticsUserId("user_123");
    confirmAuthenticatedAnalyticsUserId("user_123");
    flushPendingAuthenticatedEvents("user_123");
    mockCapture.mockClear();
    mockPostHog.get_distinct_id.mockClear();
    mockPostHog.get_distinct_id.mockReturnValue("user_123");
    jest.useFakeTimers().setSystemTime(new Date("2026-07-14T12:00:00Z"));
  });

  it("captures each upgrade impression surface and source once per UTC day", () => {
    const properties = {
      surface: "chat_header",
      source: "upgrade_button",
      from_tier: "free",
    };

    expect(captureUpgradeCtaImpression(properties)).toBe(true);
    expect(captureUpgradeCtaImpression(properties)).toBe(false);
    expect(mockCapture).toHaveBeenCalledTimes(1);
    const firstUuid = mockCapture.mock.calls[0]?.[2]?.uuid;
    expect(mockCapture).toHaveBeenLastCalledWith(
      "upgrade_cta_impressed",
      expect.objectContaining({
        impression_dedupe_scope: "identified_user_surface_source_utc_day",
        impression_dedupe_version: 1,
        impression_utc_day: "2026-07-14",
      }),
      { uuid: expect.stringMatching(/^[0-9a-f-]{36}$/i) },
    );

    expect(
      captureUpgradeCtaImpression({
        ...properties,
        source: "mobile_menu",
      }),
    ).toBe(true);
    expect(mockCapture).toHaveBeenCalledTimes(2);
    expect(mockCapture.mock.calls[1]?.[2]?.uuid).not.toBe(firstUuid);

    jest.setSystemTime(new Date("2026-07-15T00:00:01Z"));
    expect(captureUpgradeCtaImpression(properties)).toBe(true);
    expect(mockCapture).toHaveBeenCalledTimes(3);
    expect(mockCapture.mock.calls[2]?.[2]?.uuid).not.toBe(firstUuid);
  });

  it("uses one ingestion UUID across devices for the same identified user key", () => {
    const properties = {
      surface: "pricing_dialog",
      source: "plan_cards",
      from_tier: "free",
    };

    expect(captureUpgradeCtaImpression(properties)).toBe(true);
    const firstDeviceUuid = mockCapture.mock.calls[0]?.[2]?.uuid;

    // A different device has no access to the first device's local storage.
    window.localStorage.clear();

    expect(captureUpgradeCtaImpression(properties)).toBe(true);
    const secondDeviceUuid = mockCapture.mock.calls[1]?.[2]?.uuid;

    expect(secondDeviceUuid).toBe(firstDeviceUuid);

    mockPostHog.get_distinct_id.mockReturnValue("user_456");
    window.localStorage.clear();
    expect(captureUpgradeCtaImpression(properties)).toBe(true);
    expect(mockCapture.mock.calls[2]?.[2]?.uuid).not.toBe(firstDeviceUuid);
  });

  it("adds only the PostHog session correlation header", () => {
    expect(getPostHogRequestHeaders()).toEqual({
      "x-posthog-session-id": "session_123",
    });
    expect(mockPostHog.get_distinct_id).not.toHaveBeenCalled();
  });

  it("captures content-free initial message feedback with a stable UUID", () => {
    expect(
      captureMessageFeedback({
        messageId: "message_123",
        feedbackType: "positive",
      }),
    ).toBe(true);

    expect(mockCapture).toHaveBeenCalledWith(
      "message_feedback_submitted",
      {
        message_id: "message_123",
        feedback_type: "positive",
        is_initial_feedback: true,
        feedback_event_version: 1,
      },
      { uuid: expect.stringMatching(/^[0-9a-f-]{36}$/i) },
    );

    const firstUuid = mockCapture.mock.calls[0]?.[2]?.uuid;
    captureMessageFeedback({
      messageId: "message_123",
      feedbackType: "positive",
    });
    expect(mockCapture.mock.calls[1]?.[2]?.uuid).toBe(firstUuid);

    captureMessageFeedback({
      messageId: "message_123",
      feedbackType: "negative",
      previousFeedbackType: "positive",
    });
    expect(mockCapture.mock.calls[2]?.[2]?.uuid).not.toBe(firstUuid);
  });

  it("queues message feedback until the identified PostHog client is ready", () => {
    mockPostHog.__loaded = false;

    expect(
      captureMessageFeedback({
        messageId: "message_queued",
        feedbackType: "negative",
      }),
    ).toBe(true);
    expect(mockCapture).not.toHaveBeenCalled();

    mockPostHog.__loaded = true;
    expect(flushPendingAuthenticatedEvents("user_123")).toBe(true);
    expect(mockCapture).toHaveBeenCalledWith(
      "message_feedback_submitted",
      expect.objectContaining({
        message_id: "message_queued",
        feedback_type: "negative",
      }),
      { uuid: expect.stringMatching(/^[0-9a-f-]{36}$/i) },
    );
  });

  it("discards queued feedback across logout and identity changes", () => {
    mockPostHog.__loaded = false;
    setAuthenticatedAnalyticsUserId("user_a");
    captureMessageFeedback({
      messageId: "message_user_a",
      feedbackType: "positive",
    });

    setAuthenticatedAnalyticsUserId(null);
    setAuthenticatedAnalyticsUserId("user_b");
    mockPostHog.__loaded = true;

    expect(flushPendingAuthenticatedEvents("user_b")).toBe(false);
    expect(mockCapture).not.toHaveBeenCalled();

    captureMessageFeedback({
      messageId: "message_user_b",
      feedbackType: "negative",
    });
    expect(mockCapture).not.toHaveBeenCalled();

    expect(confirmAuthenticatedAnalyticsUserId("user_b")).toBe(true);
    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockCapture).toHaveBeenCalledWith(
      "message_feedback_submitted",
      expect.objectContaining({ message_id: "message_user_b" }),
      expect.any(Object),
    );
  });

  it("queues feedback while PostHog transitions to a new identity", () => {
    setAuthenticatedAnalyticsUserId("user_b");

    expect(
      captureMessageFeedback({
        messageId: "message_during_identity_transition",
        feedbackType: "positive",
      }),
    ).toBe(true);
    expect(mockCapture).not.toHaveBeenCalled();
    expect(flushPendingAuthenticatedEvents("user_b")).toBe(false);

    expect(confirmAuthenticatedAnalyticsUserId("user_b")).toBe(true);
    expect(mockCapture).toHaveBeenCalledWith(
      "message_feedback_submitted",
      expect.objectContaining({
        message_id: "message_during_identity_transition",
      }),
      expect.any(Object),
    );
  });

  it("marks feedback changes without sending feedback details", () => {
    captureMessageFeedback({
      messageId: "message_123",
      feedbackType: "negative",
      previousFeedbackType: "positive",
    });

    const [, properties] = mockCapture.mock.calls[0];
    expect(properties).toEqual({
      message_id: "message_123",
      feedback_type: "negative",
      is_initial_feedback: false,
      previous_feedback_type: "positive",
      feedback_event_version: 1,
    });
    expect(properties).not.toHaveProperty("feedback_details");
  });
});
