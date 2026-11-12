import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { render, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import {
  createPostHogIdentitySignature,
  POSTHOG_IDENTITY_SIGNATURE_STORAGE_KEY,
} from "@/lib/analytics/identity";

jest.mock("next/navigation", () => ({
  usePathname: () => window.location.pathname,
}));

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
  getIdentifiedAnalyticsUserId: jest.fn(() => null),
  getPermittedAnalyticsUserId: jest.fn(() => null),
  loadPostHogClient: jest.fn(),
  setAuthenticatedAnalyticsUserId: jest.fn(),
}));

const mockNativeInvoke = jest.fn<(command: string) => Promise<unknown>>();
jest.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string) => mockNativeInvoke(command),
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
  getIdentifiedAnalyticsUserId,
  getPermittedAnalyticsUserId,
  loadPostHogClient,
  setAuthenticatedAnalyticsUserId,
} = jest.requireMock<typeof import("@/lib/analytics/client")>(
  "@/lib/analytics/client",
);
const { PostHogProvider } =
  require("../providers") as typeof import("../providers");
const { getUnhandledRejectionDiagnostics } =
  require("@/lib/posthog/unhandled-rejection-diagnostics") as typeof import("@/lib/posthog/unhandled-rejection-diagnostics");

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
    jest.mocked(getIdentifiedAnalyticsUserId).mockReturnValue(null);
    jest.mocked(getPermittedAnalyticsUserId).mockReturnValue(null);

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
    const stopSnapshotProperties = {
      token: "test-ingestion-token",
      distinct_id: "user-123",
      $session_id: "session-123",
      diagnostic_version: 1,
      preparation_outcome: "compacted",
      save_outcome: "acknowledged",
      before_size_bytes: 1600000,
      after_size_bytes: 100000,
      part_count: 260,
      pruned_count: 250,
      frontend_build_commit: "a".repeat(40),
      save_error_code: "message_too_large",
      convex_request_id: "0123456789abcdef",
    };
    const stopSnapshot = config.before_send({
      event: "chat_stop_snapshot_save_outcome",
      properties: {
        ...stopSnapshotProperties,
        $current_url: "private",
        $referrer: "private",
        $pathname: "private",
        $title: "private",
        command: "private",
        output: "private",
        chatId: "private",
        $set: { content: "private" },
      },
      $set: { content: "private" },
      $set_once: { content: "private" },
    });
    expect(stopSnapshot?.properties).toEqual(stopSnapshotProperties);
    expect(JSON.stringify(stopSnapshot)).not.toContain("private");
    const diffProperties = {
      token: "test-ingestion-token",
      distinct_id: "user-123",
      $session_id: "session-123",
      diagnostic_version: 1,
      diff_view_instance_id: "opaque-instance",
      stage: "view_rendered",
      view_mode: "original",
      instance_observed_computed_before_view: false,
      hackerai_frontend_build_commit: "a".repeat(40),
    };
    const diff = config.before_send({
      event: "diff_view_diagnostic",
      properties: {
        ...diffProperties,
        $current_url: "private",
        $referrer: "private",
        $title: "private",
        $pathname: "private",
        path: "private",
        content: "private",
        language: "private",
        chatId: "private",
        $set: { content: "private" },
      },
      $set: { content: "private" },
      $set_once: { content: "private" },
    });
    expect(diff?.properties).toEqual(diffProperties);
    expect(JSON.stringify(diff)).not.toContain("private");
    const disposalProperties = {
      diagnostic_version: 1,
      diff_view_instance_id: "opaque-instance",
      stage: "first_modified_editor_disposed",
      instance_observed_computed_before_disposal: false,
      modified_editor_disposed_at: 1794094000000,
      hackerai_frontend_build_commit: "a".repeat(40),
    };
    const disposal = config.before_send({
      event: "diff_view_diagnostic",
      properties: {
        ...disposalProperties,
        $current_url: "private",
        content: "private",
        language: "private",
      },
    });
    expect(disposal?.properties).toEqual(disposalProperties);
    expect(JSON.stringify(disposal)).not.toContain("private");
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

  it("exports only the strict server action context after SDK enrichment", async () => {
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
    jest.mocked(getPermittedAnalyticsUserId).mockReturnValue("user-123");
    jest.mocked(getIdentifiedAnalyticsUserId).mockReturnValue("user-123");
    mockLoadPostHogClient.mockResolvedValue(posthog);
    render(<PostHogProvider analyticsAllowed>child</PostHogProvider>);
    await waitFor(() => expect(posthog.init).toHaveBeenCalledTimes(1));
    const config = posthog.init.mock.calls[0][1] as {
      before_send: (event: unknown) => Record<string, unknown> | null;
    };

    const eventUuid = "0193a5b2-7c41-7a10-8f00-1234567890ab";
    const retained = {
      token: "phc_test",
      distinct_id: "user-123",
      $session_id: "0193a5b2-7c41-7a10-8f00-aaaaaaaaaaaa",
      $lib: "web",
      $lib_version: "1.447.5",
      $is_identified: true,
      server_action_client_diagnostic_version: 1,
      caller: "analytics_consent",
      matched_pattern: "next_unrecognized_action_message",
      reference_shape: "hex42",
      recovery_decision: "locally_handled_no_reload",
      build_state: "measured",
      hackerai_frontend_build_commit: "a".repeat(40),
      attempt_denominator_kind: "caller_settled_prefix",
      caller_settled_attempt_count: 2,
      caller_recognized_rejection_count: 1,
    };
    const accessor = jest.fn(() => "private");
    const enriched = (properties: Record<string, unknown>) => ({
      uuid: eventUuid,
      event: "server_action_client_context",
      properties: Object.defineProperties(
        {
          ...properties,
          $current_url: "https://hackerai.co/c/private?code=private",
          $referrer: "https://target.test/private",
          $pathname: "/c/private",
          $initial_current_url: "https://target.test/private",
          utm_campaign: "private",
          consent: "private",
          stripe_invoice_id: "private",
          renewal_amount: "private",
          $set: { email: "private" },
        },
        {
          // The existing private-page gate reads only URL/path fields first.
          registered_content: { get: accessor, enumerable: true },
          $window_id: { get: accessor, enumerable: true },
        },
      ),
      timestamp: new Date(1_794_094_000_000),
      $set: { email: "private" },
      $set_once: { $initial_referrer: "private" },
      private_top_level: "private",
    });

    const sanitized = config.before_send(enriched(retained));
    expect(sanitized).toEqual({
      uuid: eventUuid,
      event: "server_action_client_context",
      properties: retained,
      timestamp: new Date(1_794_094_000_000),
    });
    expect(JSON.stringify(sanitized)).not.toContain("private");
    expect(accessor).not.toHaveBeenCalled();
    expect(
      config.before_send(enriched({ ...retained, distinct_id: "user-other" })),
    ).toBeNull();
    jest.mocked(getIdentifiedAnalyticsUserId).mockReturnValue(null);
    expect(config.before_send(enriched(retained))).toBeNull();
    jest.mocked(getPermittedAnalyticsUserId).mockReturnValue("user-other");
    jest.mocked(getIdentifiedAnalyticsUserId).mockReturnValue("user-other");
    expect(config.before_send(enriched(retained))).toBeNull();
    jest.mocked(getPermittedAnalyticsUserId).mockImplementation(() => {
      throw new Error("identity unavailable");
    });
    expect(config.before_send(enriched(retained))).toBeNull();
    jest.mocked(getPermittedAnalyticsUserId).mockReturnValue("user-123");
    jest.mocked(getIdentifiedAnalyticsUserId).mockReturnValue("user-123");
    expect(
      config.before_send({
        event: "ordinary_event",
        properties: { retained: "value" },
      }),
    ).toEqual({ event: "ordinary_event", properties: { retained: "value" } });
    expect(
      config.before_send(
        enriched({ ...retained, server_action_client_diagnostic_version: "1" }),
      ),
    ).toBeNull();
    expect(
      config.before_send(
        enriched({ ...retained, recovery_decision: "reload_requested" }),
      ),
    ).toBeNull();

    // The private-page gate still runs before the event-specific projection.
    try {
      expect(
        config.before_send({
          ...enriched(retained),
          properties: {
            ...retained,
            $current_url: "https://hackerai.co/abuse/report",
          },
        }),
      ).toBeNull();
    } finally {
      // That gate blocks replay for the rest of the tab session.
      window.sessionStorage.clear();
    }
  });

  it.each([
    ["withdraws consent", false, { id: "user-123" }],
    ["switches account", true, { id: "user-b" }],
    ["signs out", true, null],
  ] as const)(
    "drops a retained server action context in the commit that %s, before identity resets",
    async (_name, nextAnalyticsAllowed, nextUser) => {
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
      // Global analytics identity is reset only by the provider's passive
      // effect, so it remains the previous owner throughout the new commit.
      jest.mocked(getPermittedAnalyticsUserId).mockReturnValue("user-123");
      jest.mocked(getIdentifiedAnalyticsUserId).mockReturnValue("user-123");
      mockLoadPostHogClient.mockResolvedValue(posthog);
      const contextEvent = () => ({
        event: "server_action_client_context",
        properties: {
          token: "phc_test",
          distinct_id: "user-123",
          server_action_client_diagnostic_version: 1,
          caller: "billing_renewal_recovery",
          matched_pattern: "server_action_missing_message",
          reference_shape: "hex42",
          recovery_decision: "locally_handled_no_reload",
          build_state: "unavailable",
          attempt_denominator_kind: "unmeasured",
        },
      });
      const retained: { beforeSend?: (event: unknown) => unknown } = {};
      const layoutResults: unknown[] = [];
      // A parent's layout effect runs after the child provider's layout effects
      // in the same commit and before any passive effect.
      function RetainedBeforeSendCaller({
        children,
      }: {
        children: React.ReactNode;
      }) {
        useLayoutEffect(() => {
          if (retained.beforeSend) {
            layoutResults.push(retained.beforeSend(contextEvent()));
          }
        });
        return <>{children}</>;
      }

      const view = render(
        <RetainedBeforeSendCaller>
          <PostHogProvider analyticsAllowed>child</PostHogProvider>
        </RetainedBeforeSendCaller>,
      );
      await waitFor(() => expect(posthog.init).toHaveBeenCalledTimes(1));
      retained.beforeSend = (
        posthog.init.mock.calls[0][1] as {
          before_send: (event: unknown) => unknown;
        }
      ).before_send;

      // Control: an unrelated commit keeps the same allowed owner.
      view.rerender(
        <RetainedBeforeSendCaller>
          <PostHogProvider analyticsAllowed>updated child</PostHogProvider>
        </RetainedBeforeSendCaller>,
      );
      expect(layoutResults).toEqual([
        expect.objectContaining({ event: "server_action_client_context" }),
      ]);

      mockUseAuth.mockReturnValue({ user: nextUser });
      view.rerender(
        <RetainedBeforeSendCaller>
          <PostHogProvider analyticsAllowed={nextAnalyticsAllowed}>
            updated child
          </PostHogProvider>
        </RetainedBeforeSendCaller>,
      );
      expect(layoutResults).toHaveLength(2);
      expect(layoutResults[1]).toBeNull();
      // Ordinary events from the retained callback are unchanged.
      expect(
        retained.beforeSend({
          event: "ordinary_event",
          properties: { retained: "value" },
        }),
      ).toEqual({ event: "ordinary_event", properties: { retained: "value" } });
      view.unmount();
    },
  );

  it("adds bounded context through before_send only while identified consent is active", async () => {
    const posthog = {
      __loaded: false,
      init: jest.fn(),
      set_config: jest.fn(),
      opt_in_capturing: jest.fn(),
      has_opted_out_capturing: jest.fn(() => false),
      identify: jest.fn(),
      capture: jest.fn(),
      sessionRecordingStarted: jest.fn(() => false),
      startSessionRecording: jest.fn(),
      stopSessionRecording: jest.fn(),
      reset: jest.fn(),
      opt_out_capturing: jest.fn(),
    };
    jest.mocked(getIdentifiedAnalyticsUserId).mockReturnValue("user-123");
    mockLoadPostHogClient.mockResolvedValue(posthog);
    const view = render(
      <PostHogProvider analyticsAllowed>child</PostHogProvider>,
    );
    await waitFor(() =>
      expect(mockConfirmAuthenticatedAnalyticsUserId).toHaveBeenCalled(),
    );
    window.dispatchEvent(
      new CustomEvent("unhandledrejection", { detail: { reason: undefined } }),
    );
    const entry = {
      type: "UnhandledRejection",
      value: "Non-Error promise rejection captured with value: undefined",
      mechanism: { handled: false, synthetic: true },
    };
    const config = posthog.init.mock.calls[0][1] as {
      before_send: (event: unknown) => any;
    };
    const retained = config.before_send({
      event: "$exception",
      properties: { $exception_list: [entry] },
    });
    expect(retained.properties).toMatchObject({
      hackerai_recent_rejection_count: 1,
    });
    expect(retained.properties.$exception_list).toEqual([entry]);
    expect(posthog.capture).not.toHaveBeenCalled();
    view.rerender(
      <PostHogProvider analyticsAllowed={false}>child</PostHogProvider>,
    );
    expect(getUnhandledRejectionDiagnostics()).toEqual({});
    window.dispatchEvent(
      new CustomEvent("unhandledrejection", { detail: { reason: undefined } }),
    );
    expect(getUnhandledRejectionDiagnostics()).toEqual({});
  });

  it("does not install a rejection observer when SDK loading finishes after unmount", async () => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise((done) => {
      resolve = done;
    });
    mockLoadPostHogClient.mockReturnValue(pending);
    jest.mocked(getIdentifiedAnalyticsUserId).mockReturnValue("user-123");
    const view = render(
      <PostHogProvider analyticsAllowed>child</PostHogProvider>,
    );
    await waitFor(() => expect(mockLoadPostHogClient).toHaveBeenCalled());
    view.unmount();
    const init = jest.fn();
    resolve({ init });
    await pending;
    expect(init).not.toHaveBeenCalled();
    expect(getUnhandledRejectionDiagnostics()).toEqual({});
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

describe("abuse reporting replay privacy", () => {
  afterEach(() => {
    window.history.replaceState({}, "", "/");
    window.sessionStorage.clear();
  });
  it("stops paid replay on entry and rejects delayed URL-less snapshots after exit and reload", async () => {
    window.history.replaceState({}, "", "/");
    window.sessionStorage.clear();
    mockUseAuth.mockReturnValue({
      user: {
        id: "paid-fixture",
        email: "fixture@example.test",
        locale: "en-US",
      },
    });
    mockUseGlobalState.mockReturnValue({ subscription: "pro" });
    const posthog = {
      __loaded: true,
      set_config: jest.fn(),
      init: jest.fn(),
      get_property: jest.fn(),
      has_opted_out_capturing: () => false,
      identify: jest.fn(),
      sessionRecordingStarted: () => false,
      startSessionRecording: jest.fn(),
      stopSessionRecording: jest.fn(),
      reset: jest.fn(),
      opt_out_capturing: jest.fn(),
    };
    mockGetPostHogClient.mockReturnValue(posthog);
    mockLoadPostHogClient.mockResolvedValue(posthog);
    const view = render(
      <PostHogProvider analyticsAllowed>
        <div>ordinary page</div>
      </PostHogProvider>,
    );
    await waitFor(() =>
      expect(posthog.startSessionRecording).toHaveBeenCalledTimes(1),
    );
    const before = posthog.set_config.mock.calls.at(-1)![0] as {
      before_send: (event: unknown) => unknown;
    };
    window.history.pushState({}, "", "/abuse");
    view.rerender(
      <PostHogProvider analyticsAllowed>
        <div className="ph-no-capture">receipt and private evidence</div>
      </PostHogProvider>,
    );
    await waitFor(() =>
      expect(posthog.stopSessionRecording).toHaveBeenCalled(),
    );
    expect(posthog.set_config).toHaveBeenCalledWith(
      expect.objectContaining({
        disable_session_recording: true,
        capture_exceptions: false,
      }),
    );
    window.history.pushState({}, "", "/");
    view.rerender(
      <PostHogProvider analyticsAllowed>
        <div>ordinary page again</div>
      </PostHogProvider>,
    );
    await waitFor(() =>
      expect(posthog.set_config.mock.calls.at(-1)![0]).toHaveProperty(
        "capture_exceptions.capture_unhandled_errors",
        true,
      ),
    );
    const delayed = {
      event: "$snapshot",
      properties: { $snapshot_data: ["synthetic buffered recording"] },
    };
    expect(before.before_send(delayed)).toBeNull();
    expect(
      (posthog.set_config.mock.calls.at(-1)![0] as typeof before).before_send(
        delayed,
      ),
    ).toBeNull();
    expect(posthog.startSessionRecording).toHaveBeenCalledTimes(1);
    view.unmount();
    render(
      <PostHogProvider analyticsAllowed>
        <div>new document in same tab</div>
      </PostHogProvider>,
    );
    await waitFor(() =>
      expect(posthog.stopSessionRecording.mock.calls.length).toBeGreaterThan(1),
    );
    expect(posthog.startSessionRecording).toHaveBeenCalledTimes(1);
  });
});

describe("Desktop runtime identity", () => {
  const originalBuild = process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;
  const identity = {
    native_app_version: "0.0.74",
    native_platform: "darwin",
    hackerai_frontend_build_commit: "a".repeat(40),
  };
  const sdk = () => ({
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
  });
  type BeforeSend = (event: unknown) => {
    event?: string;
    properties?: Record<string, unknown>;
  } | null;

  beforeAll(() => {
    // Natively injected before page scripts; no Desktop bridge is started.
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    Object.defineProperty(window, "__TAURI_OS_PLUGIN_INTERNALS__", {
      configurable: true,
      value: { platform: "macos", version: "private-os", arch: "aarch64" },
    });
  });

  beforeEach(() => {
    process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT = "A".repeat(40);
    mockNativeInvoke.mockImplementation(async (command) =>
      command === "plugin:app|version" ? "0.0.74" : undefined,
    );
    mockUseAuth.mockReturnValue({
      user: { id: "user-123", email: "user@example.com", locale: "en-US" },
    });
    mockUseGlobalState.mockReturnValue({ subscription: "pro" });
    mockGetPostHogClient.mockReturnValue(null);
  });

  afterEach(() => {
    window.history.replaceState({}, "", "/");
    window.sessionStorage.clear();
  });

  afterAll(() => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    delete (window as { __TAURI_OS_PLUGIN_INTERNALS__?: unknown })
      .__TAURI_OS_PLUGIN_INTERNALS__;
    if (originalBuild === undefined) {
      delete process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;
    } else {
      process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT = originalBuild;
    }
  });

  async function renderDesktop() {
    const posthog = sdk();
    mockLoadPostHogClient.mockResolvedValue(posthog);
    const view = render(
      <PostHogProvider analyticsAllowed>child</PostHogProvider>,
    );
    await waitFor(() => expect(posthog.init).toHaveBeenCalledTimes(1));
    const { before_send } = posthog.init.mock.calls[0][1] as {
      before_send: BeforeSend;
    };
    // The provider started the lookup; wait for that same bounded promise.
    const { startDesktopRuntimeIdentityLookup } =
      require("@/lib/analytics/desktop-runtime-identity") as typeof import("@/lib/analytics/desktop-runtime-identity");
    await startDesktopRuntimeIdentityLookup();
    return { posthog, view, beforeSend: before_send };
  }

  it("waits for the bounded native identity lookup before enabling startup capture", async () => {
    let answer!: (version: string) => void;
    mockNativeInvoke.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const posthog = sdk();
    mockLoadPostHogClient.mockResolvedValue(posthog);
    render(<PostHogProvider analyticsAllowed>child</PostHogProvider>);
    await waitFor(() =>
      expect(mockNativeInvoke).toHaveBeenCalledWith("plugin:app|version"),
    );
    const prematurelyEnabled = posthog.init.mock.calls.length;
    answer("0.0.74");
    await waitFor(() => expect(posthog.init).toHaveBeenCalledTimes(1));
    expect(prematurelyEnabled).toBe(0);
    const { before_send } = posthog.init.mock.calls[0][1] as {
      before_send: BeforeSend;
    };
    expect(
      before_send({ event: "$exception", properties: {} })?.properties,
    ).toMatchObject(identity);
  });

  it("attributes automatic exceptions after URL sanitization and enrichment", async () => {
    const { beforeSend } = await renderDesktop();
    const exception = beforeSend({
      event: "$exception",
      properties: {
        $current_url: "https://hackerai.co/c/chat?token=PRIVATE",
        $exception_list: [
          {
            type: "Error",
            value: "Desktop startup failed",
            mechanism: { handled: false, synthetic: false },
          },
        ],
        native_app_version: "PRIVATE",
        native_platform: "PRIVATE",
        hackerai_frontend_build_commit: "PRIVATE",
      },
    });
    expect(exception?.properties).toMatchObject({
      ...identity,
      $current_url: "https://hackerai.co/c/chat",
      hackerai_exception_category: "unknown",
    });
    expect(JSON.stringify(exception)).not.toContain("PRIVATE");
  });

  it("keeps identity through the strict ACK projections and preserves a valid send receipt", async () => {
    const { beforeSend } = await renderDesktop();
    const ack = {
      token: "phc_test",
      distinct_id: "user-123",
      schemaVersion: 2,
      outputProtocol: "ack-v1",
      connectionId: "connection-123",
      commandId: "command-123",
      telemetry_sample_rate: 1,
      terminalAcknowledged: true,
      durationMs: 2000,
    };
    const leaked = {
      $current_url: "https://target.test/PRIVATE",
      command: "PRIVATE",
      error: "PRIVATE",
      // Valid-looking but unreceipted caller identity is not trusted.
      native_app_version: "0.0.99",
      native_platform: "windows",
    };
    for (const final of [
      {
        outcome: "acknowledged",
        reason: "terminal_ack",
        terminalType: "error",
      },
      { outcome: "acknowledged", reason: "terminal_ack", terminalExitCode: 2 },
      { outcome: "incomplete", reason: "deadline_exceeded" },
    ]) {
      const sent = beforeSend({
        event: "desktop_ack_command_settled",
        properties: { ...ack, ...final, ...leaked },
        $set: { email: "PRIVATE" },
      });
      expect(sent?.properties).toEqual({ ...ack, ...final, ...identity });
      expect(JSON.stringify(sent)).not.toContain("PRIVATE");
    }

    const receipt = {
      native_authorization_diagnostic_version: 1,
      native_authorization_send_timeout: false,
      native_authorization_send_connect: true,
      native_authorization_send_request: false,
      native_authorization_send_elapsed_ms: 42,
      native_authorization_origin_class: "canonical_production",
      native_app_version: "0.0.73",
      native_platform: "linux",
    };
    const terminalError = {
      ...ack,
      outcome: "acknowledged",
      reason: "terminal_ack",
      terminalType: "error",
    };
    expect(
      beforeSend({
        event: "desktop_ack_command_settled",
        properties: { ...terminalError, ...receipt },
      })?.properties,
    ).toEqual({
      ...terminalError,
      ...receipt,
      hackerai_frontend_build_commit: "a".repeat(40),
    });

    const counts = {
      schemaVersion: 2,
      startedCount: 10,
      settledCount: 10,
      terminalErrorCount: 0,
      pendingAtEnd: 0,
      telemetry_sample_rate: 1,
    };
    const summary = beforeSend({
      event: "desktop_ack_delivery_summary",
      properties: { ...counts, ...leaked, $set: { content: "PRIVATE" } },
    });
    expect(summary?.properties).toEqual({ ...counts, ...identity });
  });

  it("does not bypass private-page, expected-noise or consent suppression", async () => {
    const { posthog, view, beforeSend } = await renderDesktop();
    const exception = (value: string, url = "https://hackerai.co/c/chat") => ({
      event: "$exception",
      properties: {
        $current_url: url,
        $exception_list: [{ type: "Error", value }],
      },
    });
    expect(
      beforeSend(
        exception("Desktop failure", "https://hackerai.co/abuse/report"),
      ),
    ).toBeNull();
    expect(
      beforeSend(
        exception(
          "ResizeObserver loop completed with undelivered notifications.",
        ),
      ),
    ).toBeNull();

    posthog.__loaded = true;
    mockGetPostHogClient.mockReturnValue(posthog);
    view.rerender(
      <PostHogProvider analyticsAllowed={false}>child</PostHogProvider>,
    );
    const withdrawn = posthog.set_config.mock.calls.at(-1)![0] as {
      before_send: BeforeSend;
    };
    expect(withdrawn.before_send(exception("Desktop failure"))).toBeNull();
    expect(posthog.opt_out_capturing).toHaveBeenCalledTimes(1);
  });
});
