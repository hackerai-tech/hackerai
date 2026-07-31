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
const { loadPostHogClient } = jest.requireMock<
  typeof import("@/lib/analytics/client")
>("@/lib/analytics/client");
const { PostHogProvider } =
  require("../providers") as typeof import("../providers");

const mockUseAuth = useAuth as jest.Mock;
const mockUseGlobalState = useGlobalState as jest.Mock;
const mockLoadPostHogClient = loadPostHogClient as jest.Mock;

describe("PostHogProvider", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    process.env.NEXT_PUBLIC_POSTHOG_HOST = "https://us.i.posthog.com";
    window.localStorage.clear();

    mockUseGlobalState.mockReturnValue({
      subscription: "pro",
    });

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
      <PostHogProvider>
        <div>child</div>
      </PostHogProvider>,
    );

    await waitFor(() => expect(posthog.identify).toHaveBeenCalledTimes(1));
    expect(posthog.identify).toHaveBeenCalledWith("user-deduped", undefined);
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
});
