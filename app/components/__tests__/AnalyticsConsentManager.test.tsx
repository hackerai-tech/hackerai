import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig } from "swr";

const mockSaveAnalyticsConsent = jest.fn<() => Promise<void>>();
const mockResolvePendingReferral = jest.fn();
const mockFetch = jest.fn<typeof fetch>();
const mockPostHogCapture = jest.fn();
const originalFetch = global.fetch;
const originalPostHogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const originalBuild = process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;

jest.mock("@/app/actions/analytics-consent", () => ({
  saveAnalyticsConsent: mockSaveAnalyticsConsent,
}));

jest.mock("posthog-js", () => ({
  __esModule: true,
  default: { __loaded: true, capture: mockPostHogCapture },
}));

jest.mock("@/lib/influencers/pending-referral", () => ({
  resolvePendingInfluencerReferral: mockResolvePendingReferral,
}));

jest.mock("@/app/providers", () => ({
  PostHogProvider: ({
    analyticsAllowed,
    children,
    firstTouchAttribution,
  }: {
    analyticsAllowed: boolean;
    children: React.ReactNode;
    firstTouchAttribution?: { source: string; referringDomain: string } | null;
  }) => (
    <div
      data-testid="posthog-provider"
      data-analytics-allowed={analyticsAllowed}
      data-first-touch-source={firstTouchAttribution?.source}
      data-first-touch-referrer={firstTouchAttribution?.referringDomain}
    >
      {children}
    </div>
  ),
}));

const { AnalyticsConsentManager, AnalyticsConsentPreferences } =
  require("../AnalyticsConsentManager") as typeof import("../AnalyticsConsentManager");
const {
  confirmAuthenticatedAnalyticsUserId,
  loadPostHogClient,
  setAuthenticatedAnalyticsUserId,
} =
  require("@/lib/analytics/client") as typeof import("@/lib/analytics/client");

const BUILD = "ABCDEF0123".repeat(4);
const SAVE_ERROR = "We couldn't save your choice. Please try again.";
const unavailableAction = () =>
  new Error(
    `Server Action "${"0a".repeat(21)}" was not found on the server. \nRead more: https://nextjs.org/docs/messages/failed-to-find-server-action`,
  );

/** Mirrors the provider's queue owner: null unless consent permits this user. */
function setAnalyticsOwner(userId: string | null, identified = true) {
  setAuthenticatedAnalyticsUserId(userId);
  if (userId && identified) confirmAuthenticatedAnalyticsUserId(userId);
}

function serverActionContexts() {
  return mockPostHogCapture.mock.calls.filter(
    ([event]) => event === "server_action_client_context",
  );
}

function TestContent() {
  return (
    <>
      <div>App content</div>
      <AnalyticsConsentPreferences>
        <button type="button">Cookie settings</button>
      </AnalyticsConsentPreferences>
    </>
  );
}

function renderWithFreshSWR(children: React.ReactNode) {
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>{children}</SWRConfig>,
  );
}

describe("AnalyticsConsentManager", () => {
  beforeAll(async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT = BUILD;
    await loadPostHogClient();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockSaveAnalyticsConsent.mockResolvedValue(undefined);
    global.fetch = mockFetch;
    setAnalyticsOwner(null);
    window.sessionStorage.clear();
  });

  afterAll(() => {
    global.fetch = originalFetch;
    for (const [key, value] of [
      ["NEXT_PUBLIC_POSTHOG_KEY", originalPostHogKey],
      ["NEXT_PUBLIC_HACKERAI_BUILD_COMMIT", originalBuild],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("keeps the save error for an unavailable opt-in action and records its local context", async () => {
    setAnalyticsOwner("user-a");
    mockSaveAnalyticsConsent
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(unavailableAction());
    const user = userEvent.setup();
    render(
      <AnalyticsConsentManager consentRequired initialConsent="accepted">
        <TestContent />
      </AnalyticsConsentManager>,
    );

    await user.click(screen.getByRole("button", { name: "Cookie settings" }));
    await user.click(screen.getByRole("button", { name: "Allow analytics" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Allow analytics" }),
      ).not.toBeInTheDocument(),
    );
    expect(serverActionContexts()).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Cookie settings" }));
    await user.click(screen.getByRole("button", { name: "Allow analytics" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(SAVE_ERROR);
    expect(
      screen.getByRole("button", { name: "Allow analytics" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: "Allow analytics" }),
    ).toBeEnabled();
    expect(mockSaveAnalyticsConsent.mock.calls).toEqual([
      ["accepted"],
      ["accepted"],
    ]);
    expect(serverActionContexts()).toEqual([
      [
        "server_action_client_context",
        {
          server_action_client_diagnostic_version: 1,
          caller: "analytics_consent",
          matched_pattern: "next_unrecognized_action_message",
          reference_shape: "hex42",
          recovery_decision: "locally_handled_no_reload",
          build_state: "measured",
          hackerai_frontend_build_commit: BUILD.toLowerCase(),
          attempt_denominator_kind: "caller_settled_prefix",
          caller_settled_attempt_count: 2,
          caller_recognized_rejection_count: 1,
        },
        { uuid: expect.any(String) },
      ],
    ]);
    // A locally handled action failure does not enter global reload recovery.
    expect(
      window.sessionStorage.getItem("hackerai:chunk-load-reload-at"),
    ).toBeNull();
  });

  it("records nothing for an attempted decline under a previously accepted choice", async () => {
    setAnalyticsOwner("user-a");
    mockSaveAnalyticsConsent.mockRejectedValue(unavailableAction());
    const user = userEvent.setup();
    render(
      <AnalyticsConsentManager consentRequired initialConsent="accepted">
        <TestContent />
      </AnalyticsConsentManager>,
    );

    await user.click(screen.getByRole("button", { name: "Cookie settings" }));
    await user.click(screen.getByRole("button", { name: "Decline" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(SAVE_ERROR);
    expect(mockSaveAnalyticsConsent).toHaveBeenCalledWith("declined");
    expect(
      screen.getByRole("button", { name: "Allow analytics" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(serverActionContexts()).toEqual([]);
  });

  it.each([
    ["an anonymous visitor", null, true],
    ["an unidentified pending owner", "user-a", false],
  ] as const)(
    "records nothing for a failed first opt-in by %s",
    async (_name, owner, identified) => {
      setAnalyticsOwner(owner, identified);
      mockSaveAnalyticsConsent.mockRejectedValue(unavailableAction());
      const user = userEvent.setup();
      render(
        <AnalyticsConsentManager consentRequired initialConsent={null}>
          <TestContent />
        </AnalyticsConsentManager>,
      );

      await user.click(screen.getByRole("button", { name: "Allow analytics" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(SAVE_ERROR);
      expect(screen.getByTestId("posthog-provider")).toHaveAttribute(
        "data-analytics-allowed",
        "false",
      );
      expect(serverActionContexts()).toEqual([]);
    },
  );

  it.each([
    ["switches account", ["user-b"]],
    ["withdraws consent", [null]],
    ["leaves and re-enters", [null, "user-a"]],
  ] as const)(
    "drops a pending opt-in failure when the analytics owner %s",
    async (_name, transitions) => {
      setAnalyticsOwner("user-a");
      let rejectSave: ((error: Error) => void) | undefined;
      mockSaveAnalyticsConsent.mockImplementation(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectSave = reject;
          }),
      );
      const user = userEvent.setup();
      render(
        <AnalyticsConsentManager consentRequired initialConsent="accepted">
          <TestContent />
        </AnalyticsConsentManager>,
      );

      await user.click(screen.getByRole("button", { name: "Cookie settings" }));
      await user.click(screen.getByRole("button", { name: "Allow analytics" }));
      transitions.forEach((owner) => setAnalyticsOwner(owner));
      await act(async () => rejectSave?.(unavailableAction()));

      expect(await screen.findByRole("alert")).toHaveTextContent(SAVE_ERROR);
      expect(serverActionContexts()).toEqual([]);
    },
  );

  it("blocks analytics and asks covered visitors for a choice", () => {
    render(
      <AnalyticsConsentManager consentRequired initialConsent={null}>
        <TestContent />
      </AnalyticsConsentManager>,
    );

    expect(screen.getByText("Optional analytics")).toBeInTheDocument();
    expect(screen.queryByText(/session replay/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("posthog-provider")).toHaveAttribute(
      "data-analytics-allowed",
      "false",
    );
    expect(
      screen.queryByRole("button", { name: "Cookie settings" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("App content")).toBeInTheDocument();
  });

  it("keeps rejection reversible without enabling analytics", async () => {
    const user = userEvent.setup();
    render(
      <AnalyticsConsentManager consentRequired initialConsent={null}>
        <TestContent />
      </AnalyticsConsentManager>,
    );

    await user.click(screen.getByRole("button", { name: "Decline" }));

    await waitFor(() =>
      expect(mockSaveAnalyticsConsent).toHaveBeenCalledWith("declined"),
    );
    expect(screen.getByTestId("posthog-provider")).toHaveAttribute(
      "data-analytics-allowed",
      "false",
    );
    expect(
      screen.getByRole("button", { name: "Cookie settings" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cookie settings" }));
    expect(screen.getByRole("button", { name: "Decline" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.getByRole("button", { name: "Allow analytics" }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("enables analytics only after the consent write succeeds", async () => {
    let finishSave: (() => void) | undefined;
    mockSaveAnalyticsConsent.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    );
    const user = userEvent.setup();
    render(
      <AnalyticsConsentManager consentRequired initialConsent={null}>
        <TestContent />
      </AnalyticsConsentManager>,
    );

    await user.click(screen.getByRole("button", { name: "Allow analytics" }));
    expect(mockResolvePendingReferral).not.toHaveBeenCalledWith(
      window,
      "accepted",
    );
    expect(screen.getByTestId("posthog-provider")).toHaveAttribute(
      "data-analytics-allowed",
      "false",
    );

    finishSave?.();
    await waitFor(() =>
      expect(mockResolvePendingReferral).toHaveBeenCalledWith(
        window,
        "accepted",
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("posthog-provider")).toHaveAttribute(
        "data-analytics-allowed",
        "true",
      ),
    );

    await user.click(screen.getByRole("button", { name: "Cookie settings" }));
    expect(
      screen.getByRole("button", { name: "Allow analytics" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps analytics blocked and reports a failed save", async () => {
    mockSaveAnalyticsConsent.mockRejectedValue(new Error("network"));
    const user = userEvent.setup();
    render(
      <AnalyticsConsentManager consentRequired initialConsent={null}>
        <TestContent />
      </AnalyticsConsentManager>,
    );

    await user.click(screen.getByRole("button", { name: "Allow analytics" }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(mockResolvePendingReferral).not.toHaveBeenCalledWith(
      window,
      "accepted",
    );
    expect(screen.getByTestId("posthog-provider")).toHaveAttribute(
      "data-analytics-allowed",
      "false",
    );
  });

  it("does not interrupt an unregulated visitor without a saved choice", () => {
    render(
      <AnalyticsConsentManager consentRequired={false} initialConsent={null}>
        <TestContent />
      </AnalyticsConsentManager>,
    );

    expect(screen.queryByText("Optional analytics")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Cookie settings" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Privacy choices" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("posthog-provider")).toHaveAttribute(
      "data-analytics-allowed",
      "true",
    );
  });

  it("resolves a static-page visitor before enabling analytics", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ consent: null, consentRequired: false }),
    } as Response);

    renderWithFreshSWR(
      <AnalyticsConsentManager
        consentRequired
        initialConsent={null}
        initialDecisionResolved={false}
      >
        <TestContent />
      </AnalyticsConsentManager>,
    );

    expect(screen.queryByText("Optional analytics")).not.toBeInTheDocument();
    expect(screen.getByTestId("posthog-provider")).toHaveAttribute(
      "data-analytics-allowed",
      "false",
    );

    await waitFor(() =>
      expect(screen.getByTestId("posthog-provider")).toHaveAttribute(
        "data-analytics-allowed",
        "true",
      ),
    );
    expect(mockFetch).toHaveBeenCalledWith("/api/analytics-consent", {
      cache: "no-store",
      credentials: "same-origin",
    });
    expect(screen.queryByText("Optional analytics")).not.toBeInTheDocument();
  });

  it("asks a covered static-page visitor after resolving their region", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ consent: null, consentRequired: true }),
    } as Response);

    renderWithFreshSWR(
      <AnalyticsConsentManager
        consentRequired
        initialConsent={null}
        initialDecisionResolved={false}
      >
        <TestContent />
      </AnalyticsConsentManager>,
    );

    expect(await screen.findByText("Optional analytics")).toBeInTheDocument();
    expect(screen.getByTestId("posthog-provider")).toHaveAttribute(
      "data-analytics-allowed",
      "false",
    );
  });

  it("fails closed when static-page consent resolution fails", async () => {
    mockFetch.mockRejectedValue(new Error("network"));

    renderWithFreshSWR(
      <AnalyticsConsentManager
        consentRequired={false}
        initialConsent={null}
        initialDecisionResolved={false}
      >
        <TestContent />
      </AnalyticsConsentManager>,
    );

    expect(await screen.findByText("Optional analytics")).toBeInTheDocument();
    expect(screen.getByTestId("posthog-provider")).toHaveAttribute(
      "data-analytics-allowed",
      "false",
    );
  });

  it("forwards assistant first-touch attribution to PostHog", () => {
    render(
      <AnalyticsConsentManager
        consentRequired={false}
        initialConsent={null}
        firstTouchAttribution={{
          version: 1,
          source: "chatgpt",
          medium: "campaign",
          referringDomain: "$direct",
          entrySurface: "product",
          capturedAt: "2026-09-01T12:00:00.000Z",
        }}
      >
        <TestContent />
      </AnalyticsConsentManager>,
    );

    expect(screen.getByTestId("posthog-provider")).toHaveAttribute(
      "data-first-touch-source",
      "chatgpt",
    );
    expect(screen.getByTestId("posthog-provider")).toHaveAttribute(
      "data-first-touch-referrer",
      "$direct",
    );
  });

  it("keeps preferences available when an unregulated visitor has a saved choice", () => {
    render(
      <AnalyticsConsentManager
        consentRequired={false}
        initialConsent="declined"
      >
        <TestContent />
      </AnalyticsConsentManager>,
    );

    expect(screen.queryByText("Optional analytics")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Cookie settings" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("posthog-provider")).toHaveAttribute(
      "data-analytics-allowed",
      "false",
    );
  });
});
