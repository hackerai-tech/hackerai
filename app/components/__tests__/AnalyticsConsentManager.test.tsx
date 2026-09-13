import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig } from "swr";

const mockSaveAnalyticsConsent = jest.fn<() => Promise<void>>();
const mockFetch = jest.fn<typeof fetch>();
const originalFetch = global.fetch;

jest.mock("@/app/actions/analytics-consent", () => ({
  saveAnalyticsConsent: mockSaveAnalyticsConsent,
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
  beforeEach(() => {
    jest.clearAllMocks();
    mockSaveAnalyticsConsent.mockResolvedValue(undefined);
    global.fetch = mockFetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

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
    expect(screen.getByTestId("posthog-provider")).toHaveAttribute(
      "data-analytics-allowed",
      "false",
    );

    finishSave?.();
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
