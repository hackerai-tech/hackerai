import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { render, screen, waitFor } from "@testing-library/react";

jest.mock("@workos-inc/authkit-nextjs/components", () => ({
  useAuth: jest.fn(),
}));

jest.mock("../contexts/GlobalState", () => ({
  useGlobalState: jest.fn(() => ({
    agentPermissionMode: "full_access",
    chatMode: "ask",
    setAgentPermissionMode: jest.fn(),
    setChatMode: jest.fn(),
    subscription: "pro",
    temporaryChatsEnabled: false,
  })),
}));

jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: jest.fn(() => true),
  getPostHogClient: jest.fn(() => null),
  loadPostHogClient: jest.fn(),
}));

process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
process.env.NEXT_PUBLIC_POSTHOG_HOST = "https://us.i.posthog.com";

const { useAuth } = jest.requireMock<
  typeof import("@workos-inc/authkit-nextjs/components")
>("@workos-inc/authkit-nextjs/components");
const { useGlobalState } = jest.requireMock<
  typeof import("../contexts/GlobalState")
>("../contexts/GlobalState");
const { captureAuthenticatedEvent, loadPostHogClient } = jest.requireMock<
  typeof import("@/lib/analytics/client")
>("@/lib/analytics/client");
const { PostHogProvider } =
  require("../providers") as typeof import("../providers");
const { useHac45AgentOnlyTreatment } =
  require("../contexts/Hac45AgentOnlyContext") as typeof import("../contexts/Hac45AgentOnlyContext");

const mockUseAuth = useAuth as jest.Mock;
const mockUseGlobalState = useGlobalState as jest.Mock;
const mockCaptureAuthenticatedEvent = captureAuthenticatedEvent as jest.Mock;
const mockLoadPostHogClient = loadPostHogClient as jest.Mock;

function TreatmentProbe() {
  const active = useHac45AgentOnlyTreatment();
  return <div data-testid="hac45-treatment">{String(active)}</div>;
}

describe("PostHogProvider", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    process.env.NEXT_PUBLIC_POSTHOG_HOST = "https://us.i.posthog.com";
    window.localStorage.clear();

    mockUseGlobalState.mockReturnValue({
      agentPermissionMode: "full_access",
      chatMode: "ask",
      setAgentPermissionMode: jest.fn(),
      setChatMode: jest.fn(),
      subscription: "pro",
      temporaryChatsEnabled: false,
    });
    mockCaptureAuthenticatedEvent.mockReturnValue(true);

    mockUseAuth.mockReturnValue({
      user: {
        id: "user-123",
        email: "user@example.com",
        firstName: "Test",
        lastName: "User",
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
      isFeatureEnabled: jest.fn(() => false),
      onFeatureFlags: jest.fn(() => jest.fn()),
      sessionRecordingStarted: jest.fn(() => false),
      startSessionRecording: jest.fn(),
      stopSessionRecording: jest.fn(),
      reset: jest.fn(),
      opt_out_capturing: jest.fn(),
    };
    mockLoadPostHogClient.mockResolvedValue(posthog);

    render(
      <PostHogProvider>
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
      }),
    );
    expect(posthog.set_config).not.toHaveBeenCalled();
    expect(posthog.opt_in_capturing).toHaveBeenCalledWith({
      captureEventName: false,
    });
  });

  it("applies exception hooks when the shared client is already initialized", async () => {
    const posthog = {
      __loaded: true,
      init: jest.fn(),
      set_config: jest.fn(),
      opt_in_capturing: jest.fn(),
      has_opted_out_capturing: jest.fn(() => false),
      identify: jest.fn(),
      isFeatureEnabled: jest.fn(() => false),
      onFeatureFlags: jest.fn(() => jest.fn()),
      sessionRecordingStarted: jest.fn(() => false),
      startSessionRecording: jest.fn(),
      stopSessionRecording: jest.fn(),
      reset: jest.fn(),
      opt_out_capturing: jest.fn(),
    };
    mockLoadPostHogClient.mockResolvedValue(posthog);

    render(
      <PostHogProvider>
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

  it("applies the HAC-45 treatment only after the selected flag evaluates", async () => {
    const setAgentPermissionMode = jest.fn();
    const setChatMode = jest.fn();
    mockUseGlobalState.mockReturnValue({
      agentPermissionMode: "full_access",
      chatMode: "ask",
      setAgentPermissionMode,
      setChatMode,
      subscription: "pro",
      temporaryChatsEnabled: false,
    });

    const posthog = {
      __loaded: true,
      init: jest.fn(),
      set_config: jest.fn(),
      opt_in_capturing: jest.fn(),
      has_opted_out_capturing: jest.fn(() => false),
      identify: jest.fn(),
      isFeatureEnabled: jest.fn(() => true),
      onFeatureFlags: jest.fn((callback: () => void) => {
        callback();
        return jest.fn();
      }),
      sessionRecordingStarted: jest.fn(() => false),
      startSessionRecording: jest.fn(),
      stopSessionRecording: jest.fn(),
      reset: jest.fn(),
      opt_out_capturing: jest.fn(),
    };
    mockLoadPostHogClient.mockResolvedValue(posthog);

    render(
      <PostHogProvider>
        <TreatmentProbe />
      </PostHogProvider>,
    );

    await waitFor(() => {
      expect(setAgentPermissionMode).toHaveBeenCalledWith("full_access");
      expect(setChatMode).toHaveBeenCalledWith("agent");
      expect(screen.getByTestId("hac45-treatment")).toHaveTextContent("true");
    });
    expect(posthog.isFeatureEnabled).toHaveBeenCalledWith(
      "hac45-agent-full-access-v2",
    );
    expect(mockCaptureAuthenticatedEvent).toHaveBeenCalledWith(
      "hac45_agent_full_access_experiment_exposed",
      expect.objectContaining({
        variant: "agent_full_access",
        exposure_event_version: 2,
        previous_chat_mode: "ask",
        previous_agent_permission_mode: "full_access",
        agent_permission_mode: "full_access",
      }),
      { uuid: expect.any(String) },
    );
  });
});
