import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { render, waitFor } from "@testing-library/react";

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
const { loadPostHogClient } = jest.requireMock<
  typeof import("@/lib/analytics/client")
>("@/lib/analytics/client");
const { PostHogProvider } =
  require("../providers") as typeof import("../providers");

const mockUseAuth = useAuth as jest.Mock;
const mockLoadPostHogClient = loadPostHogClient as jest.Mock;

describe("PostHogProvider", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    process.env.NEXT_PUBLIC_POSTHOG_HOST = "https://us.i.posthog.com";

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
      opt_in_capturing: jest.fn(),
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
      }),
    );
  });
});
