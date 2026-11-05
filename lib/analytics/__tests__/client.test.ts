import {
  afterEach,
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
  captureAuthenticatedEvent,
  captureQueuedAuthenticatedEvent,
  getIdentifiedAnalyticsUserId,
  subscribeAuthenticatedAnalytics,
  captureComputerActivationImpression,
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

  describe("native auth frontend build attribution", () => {
    const originalBuild = process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;
    const properties = {
      native_auth_diagnostic_version: 1,
      convex_request_id: "0123456789abcdef",
    };

    beforeEach(() => {
      process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT = "A".repeat(40);
    });

    afterEach(() => {
      if (originalBuild === undefined) {
        delete process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;
      } else {
        process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT = originalBuild;
      }
    });

    it.each([
      "sandbox_connection_terminated",
      "desktop_bridge_relay_state_changed",
    ])(
      "attributes %s to the loaded frontend without mutating its diagnostic",
      (event) => {
        expect(captureAuthenticatedEvent(event, properties)).toBe(true);
        expect(mockCapture).toHaveBeenCalledWith(event, {
          ...properties,
          hackerai_frontend_build_commit: "a".repeat(40),
        });
        expect(properties).not.toHaveProperty("hackerai_frontend_build_commit");
      },
    );

    it.each([undefined, "a".repeat(39), "a".repeat(41), "g".repeat(40)])(
      "omits an absent or malformed build without dropping the diagnostic (%s)",
      (build) => {
        if (build === undefined) {
          delete process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;
        } else {
          process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT = build;
        }
        expect(
          captureAuthenticatedEvent(
            "sandbox_connection_terminated",
            properties,
          ),
        ).toBe(true);
        expect(mockCapture).toHaveBeenCalledWith(
          "sandbox_connection_terminated",
          properties,
        );
      },
    );

    it.each<[string, Record<string, unknown>]>([
      ["unrelated_event", properties],
      ["sandbox_connection_terminated", { native_auth_diagnostic_version: 2 }],
      ["desktop_bridge_relay_state_changed", { reason: "connected" }],
    ])(
      "preserves diagnostics outside the versioned auth scope (%s)",
      (event, diagnostic) => {
        expect(captureAuthenticatedEvent(event, diagnostic)).toBe(true);
        expect(mockCapture).toHaveBeenCalledWith(event, diagnostic);
      },
    );

    it("attributes a queued diagnostic when the identified SDK becomes ready", async () => {
      mockPostHog.__loaded = false;
      expect(
        captureQueuedAuthenticatedEvent({
          event: "sandbox_connection_terminated",
          properties,
          dedupeKey: "owned-native-auth-fixture",
        }),
      ).toBe(true);
      expect(mockCapture).not.toHaveBeenCalled();
      mockPostHog.__loaded = true;
      expect(flushPendingAuthenticatedEvents("user_123")).toBe(true);
      await Promise.resolve();
      expect(mockCapture).toHaveBeenCalledTimes(1);
      expect(mockCapture).toHaveBeenCalledWith(
        "sandbox_connection_terminated",
        { ...properties, hackerai_frontend_build_commit: "a".repeat(40) },
        { uuid: expect.stringMatching(/^[0-9a-f-]{36}$/i) },
      );
    });

    it("retains best-effort capture failure without retrying the diagnostic", () => {
      mockCapture.mockImplementationOnce(() => {
        throw new Error("SDK unavailable");
      });
      expect(
        captureAuthenticatedEvent("sandbox_connection_terminated", properties),
      ).toBe(false);
      expect(mockCapture).toHaveBeenCalledTimes(1);
    });

    it.each(["not configured", "SDK not ready"])(
      "does not bypass the existing capture gate when %s",
      (state) => {
        const originalKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
        try {
          if (state === "not configured") {
            delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
          } else {
            mockPostHog.__loaded = false;
          }
          expect(
            captureAuthenticatedEvent(
              "sandbox_connection_terminated",
              properties,
            ),
          ).toBe(false);
          expect(mockCapture).not.toHaveBeenCalled();
        } finally {
          if (originalKey === undefined) {
            delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
          } else {
            process.env.NEXT_PUBLIC_POSTHOG_KEY = originalKey;
          }
          mockPostHog.__loaded = true;
        }
      },
    );
  });

  it("notifies survey consumers only of the consented, identified account", () => {
    const listener = jest.fn();
    const unsubscribe = subscribeAuthenticatedAnalytics(listener);
    expect(getIdentifiedAnalyticsUserId()).toBe("user_123");
    setAuthenticatedAnalyticsUserId("new-user");
    expect(getIdentifiedAnalyticsUserId()).toBeNull();
    confirmAuthenticatedAnalyticsUserId("user_123");
    expect(getIdentifiedAnalyticsUserId()).toBeNull();
    confirmAuthenticatedAnalyticsUserId("new-user");
    expect(getIdentifiedAnalyticsUserId()).toBe("new-user");
    setAuthenticatedAnalyticsUserId(null);
    expect(getIdentifiedAnalyticsUserId()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
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

  it("deduplicates computer impressions across mounts without suppressing upgrade impressions", () => {
    const properties = {
      surface: "chat_input_computer_activation",
      source: "free_ask_computer_activation",
    };
    expect(captureComputerActivationImpression(properties)).toBe(true);
    expect(captureComputerActivationImpression(properties)).toBe(true);
    const uuid = mockCapture.mock.calls[0]?.[2]?.uuid;
    expect(captureUpgradeCtaImpression(properties)).toBe(true);
    expect(mockCapture.mock.calls[1]?.[2]?.uuid).not.toBe(uuid);
    window.localStorage.clear();
    expect(captureComputerActivationImpression(properties)).toBe(true);
    expect(mockCapture.mock.calls[2]?.[2]?.uuid).toBe(uuid);
    mockPostHog.get_distinct_id.mockReturnValue("another-user");
    expect(captureComputerActivationImpression(properties)).toBe(true);
    expect(mockCapture.mock.calls[3]?.[2]?.uuid).not.toBe(uuid);
    jest.setSystemTime(new Date("2026-07-15T00:00:01Z"));
    expect(captureComputerActivationImpression(properties)).toBe(true);
    expect(mockCapture.mock.calls[4]?.[2]?.uuid).not.toBe(
      mockCapture.mock.calls[3]?.[2]?.uuid,
    );
  });

  it("can retry a computer impression after capture fails", () => {
    const properties = { surface: "chat_input_computer_activation" };
    mockCapture.mockImplementationOnce(() => {
      throw new Error("unavailable");
    });
    expect(captureComputerActivationImpression(properties)).toBe(false);
    expect(captureComputerActivationImpression(properties)).toBe(true);
    expect(captureComputerActivationImpression(properties)).toBe(true);
  });

  it("waits for SDK initialization before handling a computer impression", () => {
    mockPostHog.__loaded = false;
    const properties = { surface: "chat_input_computer_activation" };
    expect(captureComputerActivationImpression(properties)).toBe(false);
    expect(mockCapture).not.toHaveBeenCalled();
    mockPostHog.__loaded = true;
    expect(captureComputerActivationImpression(properties)).toBe(true);
    expect(captureComputerActivationImpression(properties)).toBe(true);
    expect(mockCapture).toHaveBeenCalledTimes(1);
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
