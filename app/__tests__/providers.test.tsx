import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { render, waitFor } from "@testing-library/react";
import {
  createPostHogIdentitySignature,
  POSTHOG_IDENTITY_SIGNATURE_STORAGE_KEY,
} from "@/lib/analytics/identity";

jest.mock("@workos-inc/authkit-nextjs/components", () => ({
  useAuth: jest.fn(),
}));

jest.mock("../contexts/GlobalState", () => ({
  useGlobalState: jest.fn(() => ({
    subscription: "pro",
  })),
}));

jest.mock("@/lib/analytics/client", () => ({
  confirmAuthenticatedAnalyticsUserId: jest.fn(),
  getPostHogClient: jest.fn(() => null),
  loadPostHogClient: jest.fn(),
  setAuthenticatedAnalyticsUserId: jest.fn(),
}));

process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
process.env.NEXT_PUBLIC_POSTHOG_HOST = "https://us.i.posthog.com";

const { useAuth } = jest.requireMock<
  typeof import("@workos-inc/authkit-nextjs/components")
>("@workos-inc/authkit-nextjs/components");
const { useGlobalState } = jest.requireMock<
  typeof import("../contexts/GlobalState")
>("../contexts/GlobalState");
const {
  confirmAuthenticatedAnalyticsUserId,
  getPostHogClient,
  loadPostHogClient,
  setAuthenticatedAnalyticsUserId,
} = jest.requireMock<typeof import("@/lib/analytics/client")>(
  "@/lib/analytics/client",
);
const { PostHogProvider } =
  require("../providers") as typeof import("../providers");

const mockUseAuth = useAuth as jest.Mock;
const mockUseGlobalState = useGlobalState as jest.Mock;
const mockConfirmAuthenticatedAnalyticsUserId =
  confirmAuthenticatedAnalyticsUserId as jest.Mock;
const mockGetPostHogClient = getPostHogClient as jest.Mock;
const mockLoadPostHogClient = loadPostHogClient as jest.Mock;
const mockSetAuthenticatedAnalyticsUserId =
  setAuthenticatedAnalyticsUserId as jest.Mock;

describe("PostHogProvider", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    process.env.NEXT_PUBLIC_POSTHOG_HOST = "https://us.i.posthog.com";
    window.localStorage.clear();
    mockGetPostHogClient.mockReturnValue(null);

    mockUseGlobalState.mockReturnValue({
      subscription: "pro",
    });

    mockUseAuth.mockReturnValue({
      user: {
        id: "user-123",
        email: "user@example.com",
        firstName: "Test",
        lastName: "User",
        locale: "en-US",
      },
    });
  });

  it("enables only unhandled browser exception autocapture", async () => {
    const posthog = {
      __loaded: false,
      init: jest.fn(),
      set_config: jest.fn(),
      opt_in_capturing: jest.fn(),
      has_opted_out_capturing: jest.fn(() => true),
      identify: jest.fn(),
      sessionRecordingStarted: jest.fn(() => false),
      startSessionRecording: jest.fn(),
      stopSessionRecording: jest.fn(),
      reset: jest.fn(),
      opt_out_capturing: jest.fn(),
    };
    mockLoadPostHogClient.mockResolvedValue(posthog);

    render(
      <PostHogProvider analyticsAllowed>
        <div>child</div>
      </PostHogProvider>,
    );

    await waitFor(() => expect(posthog.init).toHaveBeenCalledTimes(1));

    expect(posthog.init).toHaveBeenCalledWith(
      "phc_test",
      expect.objectContaining({
        capture_exceptions: {
          capture_unhandled_errors: true,
          capture_unhandled_rejections: true,
          capture_console_errors: false,
        },
        capture_pageview: false,
        autocapture: false,
        advanced_disable_feature_flags: true,
      }),
    );
    expect(posthog.set_config).not.toHaveBeenCalled();
    expect(posthog.opt_in_capturing).toHaveBeenCalledWith({
      captureEventName: false,
    });
    expect(posthog.identify).toHaveBeenCalledWith("user-123", {
      email: "user@example.com",
      name: "Test User",
      subscription: "pro",
    });
    expect(mockSetAuthenticatedAnalyticsUserId).toHaveBeenCalledWith(
      "user-123",
    );
    expect(mockConfirmAuthenticatedAnalyticsUserId).toHaveBeenCalledWith(
      "user-123",
    );
    expect(posthog.identify.mock.invocationCallOrder[0]).toBeLessThan(
      mockConfirmAuthenticatedAnalyticsUserId.mock.invocationCallOrder[0]!,
    );

    const [, config] = posthog.init.mock.calls[0] as unknown as [
      string,
      {
        before_send: (event: {
          event: string;
          properties: Record<string, unknown>;
        }) => {
          event?: string;
          properties?: Record<string, unknown>;
        } | null;
      },
    ];
    const retainedException = config.before_send({
      event: "$exception",
      properties: {
        $current_url: "https://hackerai.co/auth-error?state=secret",
        $referrer: "https://idp.example/callback?code=secret",
        $exception_values: ["Unexpected application error"],
      },
    });

    expect(retainedException?.properties).toMatchObject({
      $current_url: "https://hackerai.co/auth-error",
      $referrer: "https://idp.example/callback",
    });
    for (const event of [
      "chat_visible_response_performance",
      "chat_browser_responsiveness",
    ]) {
      const sdkEvent = {
        event,
        properties: {
          token: "test-ingestion-token",
          distinct_id: "user-123",
          $browser: "Chrome",
          first_visible_text_ms: 250,
          event_timing_entry_count: 3,
          $current_url: "https://preview.test/c/chat?secret=private",
          $referrer: "https://target.test/private",
          $initial_current_url: "https://target.test/private",
          $pathname: "/private",
          registered_content: "private",
          $set: { url: "https://target.test/private" },
        },
        $set_once: { $initial_current_url: "https://target.test/private" },
        $set: { private_content: "private" },
      };
      const sanitized = config.before_send(sdkEvent);
      expect(sanitized?.properties).toEqual({
        token: "test-ingestion-token",
        distinct_id: "user-123",
        $browser: "Chrome",
        first_visible_text_ms: 250,
        event_timing_entry_count: 3,
      });
      expect(JSON.stringify(sanitized)).not.toContain("private");
    }
    for (const event of [
      "desktop_ack_command_started",
      "desktop_ack_command_settled",
      "agent_run_cancellation_requested",
      "agent_run_cancellation_settled",
    ]) {
      const allowed = {
        token: "test-ingestion-token",
        distinct_id: "user-123",
        $session_id: "session-123",
        $lib: "web",
        schemaVersion: 1,

        chatId: "chat-123",
        triggerRunId: "run-123",
        hackerai_frontend_build_commit: "a".repeat(40),
        ...(event.startsWith("agent_run_cancellation")
          ? {
              cancellationId: "cancellation-123",
              action: "stop",
              reason: "stop",
              ...(event.endsWith("settled") && {
                outcome: "accepted",
                durationMs: 2000,
              }),
            }
          : {
              outputProtocol: "ack-v1",
              connectionId: "connection-123",
              commandId: "command-123",
              ...(event.endsWith("settled") && {
                outcome: "acknowledged",
                reason: "terminal_ack",
                observedFrames: 3,
                enqueuedFrames: 3,
                acknowledgedFrames: 3,
                publishAttempts: 4,
                replayAttempts: 1,
                publishFailures: 0,
                resumeRequests: 1,
                pendingFrames: 0,
                pendingBytes: 0,
                peakPendingBytes: 128,
                terminalType: "exit",
                terminalAcknowledged: true,
                durationMs: 2000,
              }),
            }),
      };
      const sanitized = config.before_send({
        event,
        properties: {
          ...allowed,
          $current_url: "https://preview.test/c/chat?secret=private",
          $referrer: "https://target.test/private",
          $pathname: "/private",
          $initial_current_url: "https://target.test/private",
          utm_campaign: "private",
          registered_content: "private",
          command: "private",
          output: "private",
          error: "private",
          $set: { private_content: "private" },
        },
        ...{
          $set: { private_content: "private" },
          $set_once: { private_content: "private" },
        },
      });
      expect(sanitized?.properties).toEqual(allowed);
      expect(JSON.stringify(sanitized)).not.toContain("private");
    }
    const summary = config.before_send({
      event: "desktop_ack_delivery_summary",
      properties: {
        schemaVersion: 2,
        startedCount: 10,
        settledCount: 9,
        pendingAtEnd: 1,
        windowSequence: 0,
        telemetry_sample_rate: 1,
        $current_url: "private",
        commandId: "private",
        chatId: "private",
        $set: { content: "private" },
      },
      $set_once: { content: "private" },
    });
    expect(summary?.properties).toEqual({
      schemaVersion: 2,
      startedCount: 10,
      settledCount: 9,
      pendingAtEnd: 1,
      windowSequence: 0,
      telemetry_sample_rate: 1,
    });
    expect(JSON.stringify(summary)).not.toContain("private");
    const ordinaryEvent = {
      event: "ordinary_event",
      properties: { retained: "value" },
    };
    expect(config.before_send(ordinaryEvent)).toEqual(ordinaryEvent);
    expect(posthog.startSessionRecording).toHaveBeenCalledTimes(1);
    expect(posthog.stopSessionRecording).not.toHaveBeenCalled();
  });

  it.each(["fr-FR", "es_ES", "invalid locale", "   "])(
    "does not record a paid user's %s session",
    async (locale) => {
      const posthog = {
        __loaded: false,
        init: jest.fn(),
        set_config: jest.fn(),
        opt_in_capturing: jest.fn(),
        has_opted_out_capturing: jest.fn(() => false),
        identify: jest.fn(),
        sessionRecordingStarted: jest.fn(() => false),
        startSessionRecording: jest.fn(),
        stopSessionRecording: jest.fn(),
        reset: jest.fn(),
        opt_out_capturing: jest.fn(),
      };
      mockUseAuth.mockReturnValue({
        user: {
          id: "user-123",
          email: "user@example.com",
          firstName: "Test",
          lastName: "User",
          locale,
        },
      });
      mockLoadPostHogClient.mockResolvedValue(posthog);

      render(
        <PostHogProvider analyticsAllowed>
          <div>child</div>
        </PostHogProvider>,
      );

      await waitFor(() =>
        expect(posthog.stopSessionRecording).toHaveBeenCalledTimes(1),
      );
      expect(posthog.startSessionRecording).not.toHaveBeenCalled();
    },
  );

  it("does not record sessions where analytics consent is required", async () => {
    const posthog = {
      __loaded: false,
      init: jest.fn(),
      set_config: jest.fn(),
      opt_in_capturing: jest.fn(),
      has_opted_out_capturing: jest.fn(() => false),
      identify: jest.fn(),
      sessionRecordingStarted: jest.fn(() => false),
      startSessionRecording: jest.fn(),
      stopSessionRecording: jest.fn(),
      reset: jest.fn(),
      opt_out_capturing: jest.fn(),
    };
    mockLoadPostHogClient.mockResolvedValue(posthog);

    render(
      <PostHogProvider analyticsAllowed consentRequired>
        <div>child</div>
      </PostHogProvider>,
    );

    await waitFor(() =>
      expect(posthog.stopSessionRecording).toHaveBeenCalledTimes(1),
    );
    expect(posthog.startSessionRecording).not.toHaveBeenCalled();
  });

  it("falls back to the primary browser locale when account locale is missing", async () => {
    const languageSpy = jest
      .spyOn(window.navigator, "language", "get")
      .mockReturnValue("en-CA");
    const posthog = {
      __loaded: false,
      init: jest.fn(),
      set_config: jest.fn(),
      opt_in_capturing: jest.fn(),
      has_opted_out_capturing: jest.fn(() => false),
      identify: jest.fn(),
      sessionRecordingStarted: jest.fn(() => false),
      startSessionRecording: jest.fn(),
      stopSessionRecording: jest.fn(),
      reset: jest.fn(),
      opt_out_capturing: jest.fn(),
    };
    mockUseAuth.mockReturnValue({
      user: {
        id: "user-123",
        email: "user@example.com",
        firstName: "Test",
        lastName: "User",
        locale: null,
      },
    });
    mockLoadPostHogClient.mockResolvedValue(posthog);

    try {
      render(
        <PostHogProvider analyticsAllowed>
          <div>child</div>
        </PostHogProvider>,
      );

      await waitFor(() =>
        expect(posthog.startSessionRecording).toHaveBeenCalledTimes(1),
      );
      expect(posthog.stopSessionRecording).not.toHaveBeenCalled();
    } finally {
      languageSpy.mockRestore();
    }
  });

  it("clears the queued analytics identity when the user signs out", () => {
    mockUseAuth.mockReturnValue({ user: null });

    render(
      <PostHogProvider analyticsAllowed>
        <div>child</div>
      </PostHogProvider>,
    );

    expect(mockSetAuthenticatedAnalyticsUserId).toHaveBeenCalledWith(null);
    expect(mockLoadPostHogClient).not.toHaveBeenCalled();
  });

  it("does not initialize or identify PostHog without analytics permission", () => {
    window.localStorage.setItem(
      POSTHOG_IDENTITY_SIGNATURE_STORAGE_KEY,
      "previous-identity",
    );

    render(
      <PostHogProvider analyticsAllowed={false}>
        <div>child</div>
      </PostHogProvider>,
    );

    expect(mockSetAuthenticatedAnalyticsUserId).toHaveBeenCalledWith(null);
    expect(mockLoadPostHogClient).not.toHaveBeenCalled();
    expect(
      window.localStorage.getItem(POSTHOG_IDENTITY_SIGNATURE_STORAGE_KEY),
    ).toBeNull();
  });

  it("stops and clears a loaded PostHog client when consent is withdrawn", () => {
    const posthog = {
      __loaded: true,
      set_config: jest.fn(),
      stopSessionRecording: jest.fn(),
      reset: jest.fn(),
      opt_out_capturing: jest.fn(),
    };
    mockGetPostHogClient.mockReturnValue(posthog);

    render(
      <PostHogProvider analyticsAllowed={false}>
        <div>child</div>
      </PostHogProvider>,
    );

    expect(posthog.stopSessionRecording).toHaveBeenCalledTimes(1);
    expect(posthog.reset).toHaveBeenCalledTimes(1);
    expect(posthog.opt_out_capturing).toHaveBeenCalledTimes(1);
  });

  it("does not resend unchanged person properties across app loads", async () => {
    const posthog = {
      __loaded: false,
      init: jest.fn(),
      set_config: jest.fn(),
      opt_in_capturing: jest.fn(),
      has_opted_out_capturing: jest.fn(() => false),
      identify: jest.fn(),
      sessionRecordingStarted: jest.fn(() => false),
      startSessionRecording: jest.fn(),
      stopSessionRecording: jest.fn(),
      reset: jest.fn(),
      opt_out_capturing: jest.fn(),
    };
    mockUseAuth.mockReturnValue({
      user: {
        id: "user-deduped",
        email: "deduped@example.com",
        firstName: "Deduped",
        lastName: "User",
      },
    });
    const signature = createPostHogIdentitySignature({
      userId: "user-deduped",
      email: "deduped@example.com",
      name: "Deduped User",
      subscription: "pro",
    });
    window.localStorage.setItem(
      POSTHOG_IDENTITY_SIGNATURE_STORAGE_KEY,
      signature,
    );
    mockLoadPostHogClient.mockResolvedValue(posthog);

    render(
      <PostHogProvider analyticsAllowed>
        <div>child</div>
      </PostHogProvider>,
    );

    await waitFor(() => expect(posthog.identify).toHaveBeenCalledTimes(1));
    expect(posthog.identify).toHaveBeenCalledWith("user-deduped", undefined);
  });

  it("sets sanitized first-touch properties once during identification", async () => {
    const posthog = {
      __loaded: false,
      init: jest.fn(),
      set_config: jest.fn(),
      opt_in_capturing: jest.fn(),
      has_opted_out_capturing: jest.fn(() => false),
      identify: jest.fn(),
      sessionRecordingStarted: jest.fn(() => false),
      startSessionRecording: jest.fn(),
      stopSessionRecording: jest.fn(),
      reset: jest.fn(),
      opt_out_capturing: jest.fn(),
    };
    mockLoadPostHogClient.mockResolvedValue(posthog);

    render(
      <PostHogProvider
        analyticsAllowed
        firstTouchAttribution={{
          version: 1,
          source: "github",
          medium: "social",
          campaign: "aug_launch",
          referringDomain: "github.com",
          entrySurface: "home",
          capturedAt: "2026-08-14T12:00:00.000Z",
        }}
      >
        <div>child</div>
      </PostHogProvider>,
    );

    await waitFor(() => expect(posthog.identify).toHaveBeenCalledTimes(1));
    expect(posthog.identify).toHaveBeenCalledWith(
      "user-123",
      {
        email: "user@example.com",
        name: "Test User",
        subscription: "pro",
      },
      {
        acquisition_attribution_version: 1,
        acquisition_source_bucket: "github",
        acquisition_attribution_source: "post_auth_identify",
        referral_link_present: false,
        first_touch_attribution_version: 1,
        first_touch_source: "github",
        first_touch_medium: "social",
        first_touch_campaign: "aug_launch",
        first_touch_referring_domain: "github.com",
        first_touch_entry_surface: "home",
        first_touch_captured_at: "2026-08-14T12:00:00.000Z",
      },
    );
  });

  it("applies exception hooks when the shared client is already initialized", async () => {
    const posthog = {
      __loaded: true,
      init: jest.fn(),
      set_config: jest.fn(),
      opt_in_capturing: jest.fn(),
      has_opted_out_capturing: jest.fn(() => false),
      identify: jest.fn(),
      sessionRecordingStarted: jest.fn(() => false),
      startSessionRecording: jest.fn(),
      stopSessionRecording: jest.fn(),
      reset: jest.fn(),
      opt_out_capturing: jest.fn(),
    };
    mockLoadPostHogClient.mockResolvedValue(posthog);

    render(
      <PostHogProvider analyticsAllowed>
        <div>child</div>
      </PostHogProvider>,
    );

    await waitFor(() => expect(posthog.set_config).toHaveBeenCalledTimes(1));

    expect(posthog.init).not.toHaveBeenCalled();
    expect(posthog.set_config).toHaveBeenCalledWith(
      expect.objectContaining({
        before_send: expect.any(Function),
        capture_exceptions: {
          capture_unhandled_errors: true,
          capture_unhandled_rejections: true,
          capture_console_errors: false,
        },
      }),
    );
  });
});

describe("X referral consent and identity continuity", () => {
  function client(restoredUser?: string) {
    let identified: string | undefined = restoredUser;
    let distinctId = restoredUser ?? "anonymous-x-visitor";
    const posthog = {
      __loaded: false,
      init: jest.fn(() => {
        posthog.__loaded = true;
      }),
      set_config: jest.fn(),
      get_property: jest.fn(() => identified),
      get_distinct_id: jest.fn(() => distinctId),
      capture: jest.fn(() => ({})),
      opt_in_capturing: jest.fn(),
      has_opted_out_capturing: jest.fn(() => false),
      identify: jest.fn((id: string) => {
        identified = id;
        distinctId = id;
      }),
      sessionRecordingStarted: jest.fn(() => false),
      startSessionRecording: jest.fn(),
      stopSessionRecording: jest.fn(),
      reset: jest.fn(() => {
        identified = undefined;
        distinctId = "new-anonymous";
      }),
      opt_out_capturing: jest.fn(),
    };
    return posthog;
  }
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    document.cookie = "hackerai_partner_visit=; Path=/; Max-Age=0";
    mockUseAuth.mockReturnValue({ user: null });
    mockUseGlobalState.mockReturnValue({ subscription: "free" });
    mockGetPostHogClient.mockReturnValue(null);
    jest
      .spyOn(document, "referrer", "get")
      .mockReturnValue("https://t.co/post");
    jest.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0");
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([false, true])(
    "captures partner arrivals with isolated funnel identity (signed in: %s)",
    async (signedIn) => {
      jest.spyOn(document, "referrer", "get").mockReturnValue("");
      const visitorId = "00000000-0000-4000-8000-000000000001";
      document.cookie = `hackerai_partner_visit=${encodeURIComponent(
        JSON.stringify({
          code: "medusa",
          visitorId,
          visitId: "00000000-0000-4000-8000-000000000002",
          timestamp: Date.now(),
          environment: "preview",
        }),
      )}; Path=/`;
      if (signedIn)
        mockUseAuth.mockReturnValue({ user: { id: "existing-user" } });
      const posthog = client(signedIn ? "existing-user" : undefined);
      mockLoadPostHogClient.mockResolvedValue(posthog);
      const view = render(
        <PostHogProvider analyticsAllowed>content</PostHogProvider>,
      );
      await waitFor(() => expect(posthog.capture).toHaveBeenCalledTimes(1));
      expect(posthog.capture).toHaveBeenCalledWith(
        "influencer_link_visited",
        expect.objectContaining({
          distinct_id: `influencer-visitor:${visitorId}`,
          influencer_code: "medusa",
        }),
        expect.anything(),
      );
      expect(posthog.get_distinct_id()).toBe(
        signedIn ? "existing-user" : "anonymous-x-visitor",
      );
      const config = (
        posthog.init.mock.calls as unknown as [
          string,
          { before_send: (event: unknown) => unknown },
        ][]
      )[0][1];
      expect(
        config.before_send({
          event: "influencer_link_visited",
          properties: {
            distinct_id: `influencer-visitor:${visitorId}`,
            $process_person_profile: true,
            $user_id: "existing-user",
            $current_url: "private",
          },
          $set: { email: "private" },
        }),
      ).toEqual({
        event: "influencer_link_visited",
        properties: {
          distinct_id: `influencer-visitor:${visitorId}`,
          $process_person_profile: false,
          $geoip_disable: true,
        },
      });
      view.unmount();
      render(<PostHogProvider analyticsAllowed>content</PostHogProvider>);
      await waitFor(() => expect(posthog.capture).toHaveBeenCalledTimes(1));
    },
  );

  it("preserves a pending arrival while consent is resolving, then captures after allowance", async () => {
    jest.spyOn(document, "referrer", "get").mockReturnValue("");
    document.cookie = `hackerai_partner_visit=${encodeURIComponent(
      JSON.stringify({
        code: "medusa",
        visitorId: "00000000-0000-4000-8000-000000000001",
        visitId: "00000000-0000-4000-8000-000000000002",
        timestamp: Date.now(),
        environment: "preview",
      }),
    )}; Path=/`;
    const posthog = client();
    mockLoadPostHogClient.mockResolvedValue(posthog);
    const view = render(
      <PostHogProvider analyticsAllowed={false}>content</PostHogProvider>,
    );
    expect(mockLoadPostHogClient).not.toHaveBeenCalled();
    expect(document.cookie).toContain("hackerai_partner_visit=");
    view.rerender(<PostHogProvider analyticsAllowed>content</PostHogProvider>);
    await waitFor(() => expect(posthog.capture).toHaveBeenCalledTimes(1));
  });

  it("clears a pending partner visit without loading analytics when consent is denied", () => {
    document.cookie = "hackerai_partner_visit=pending; Path=/";
    render(
      <PostHogProvider analyticsAllowed={false} consentDeclined>
        content
      </PostHogProvider>,
    );
    expect(document.cookie).not.toContain("hackerai_partner_visit=");
    expect(mockLoadPostHogClient).not.toHaveBeenCalled();
  });

  it("waits for consent, captures only a referral, and preserves its identity into signup", async () => {
    const posthog = client();
    mockLoadPostHogClient.mockResolvedValue(posthog);
    const view = render(
      <PostHogProvider analyticsAllowed={false}>content</PostHogProvider>,
    );
    expect(mockLoadPostHogClient).not.toHaveBeenCalled();
    view.rerender(<PostHogProvider analyticsAllowed>content</PostHogProvider>);
    await waitFor(() => expect(posthog.capture).toHaveBeenCalledTimes(1));
    expect(posthog.identify).not.toHaveBeenCalled();
    expect(posthog.startSessionRecording).not.toHaveBeenCalled();
    const config = (
      posthog.init.mock.calls as unknown as [
        string,
        { before_send: (event: unknown) => unknown },
      ][]
    )[0][1];
    expect(
      config.before_send({
        event: "$exception",
        properties: { message: "private" },
      }),
    ).toBeNull();
    expect(
      config.before_send({ event: "pricing_viewed", properties: {} }),
    ).toBeNull();

    mockGetPostHogClient.mockReturnValue(posthog);
    mockUseAuth.mockReturnValue({
      user: { id: "new-signup", email: "new@example.com" },
    });
    view.rerender(<PostHogProvider analyticsAllowed>content</PostHogProvider>);
    await waitFor(() =>
      expect(posthog.identify).toHaveBeenCalledWith(
        "new-signup",
        expect.anything(),
      ),
    );
    expect(posthog.reset).not.toHaveBeenCalled();
    expect(posthog.opt_out_capturing).not.toHaveBeenCalled();
    expect(posthog.capture).toHaveBeenCalledTimes(1);
    expect(mockConfirmAuthenticatedAnalyticsUserId).toHaveBeenCalledWith(
      "new-signup",
    );
  });

  it("keeps an anonymous identity on subsequent direct pages", async () => {
    const posthog = client();
    posthog.__loaded = true;
    mockGetPostHogClient.mockReturnValue(posthog);
    jest
      .spyOn(document, "referrer", "get")
      .mockReturnValue("https://hackerai.co/");
    render(<PostHogProvider analyticsAllowed>content</PostHogProvider>);
    expect(posthog.reset).not.toHaveBeenCalled();
    expect(posthog.opt_out_capturing).not.toHaveBeenCalled();
    expect(posthog.capture).not.toHaveBeenCalled();
    expect(mockLoadPostHogClient).not.toHaveBeenCalled();
  });

  it("resets a restored signed-out account before capturing a new visitor", async () => {
    const posthog = client("previous-account");
    mockLoadPostHogClient.mockResolvedValue(posthog);
    render(<PostHogProvider analyticsAllowed>content</PostHogProvider>);
    await waitFor(() => expect(posthog.capture).toHaveBeenCalledTimes(1));
    expect(posthog.reset).toHaveBeenCalledTimes(1);
    expect(posthog.get_distinct_id()).toBe("new-anonymous");
    expect(posthog.reset.mock.invocationCallOrder[0]).toBeLessThan(
      posthog.capture.mock.invocationCallOrder[0],
    );
    expect(posthog.identify).not.toHaveBeenCalled();
  });
});
