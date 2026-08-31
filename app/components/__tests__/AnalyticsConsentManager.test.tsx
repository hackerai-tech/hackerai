import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockSaveAnalyticsConsent = jest.fn<() => Promise<void>>();

jest.mock("@/app/actions/analytics-consent", () => ({
  saveAnalyticsConsent: mockSaveAnalyticsConsent,
}));

jest.mock("@/app/providers", () => ({
  PostHogProvider: ({
    analyticsAllowed,
    children,
  }: {
    analyticsAllowed: boolean;
    children: React.ReactNode;
  }) => (
    <div
      data-testid="posthog-provider"
      data-analytics-allowed={analyticsAllowed}
    >
      {children}
    </div>
  ),
}));

const { AnalyticsConsentManager } =
  require("../AnalyticsConsentManager") as typeof import("../AnalyticsConsentManager");

describe("AnalyticsConsentManager", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSaveAnalyticsConsent.mockResolvedValue(undefined);
  });

  it("blocks analytics and asks covered visitors for a choice", () => {
    render(
      <AnalyticsConsentManager consentRequired initialConsent={null}>
        <div>App content</div>
      </AnalyticsConsentManager>,
    );

    expect(screen.getByText("Your analytics choice")).toBeInTheDocument();
    expect(screen.getByTestId("posthog-provider")).toHaveAttribute(
      "data-analytics-allowed",
      "false",
    );
    expect(screen.getByText("App content")).toBeInTheDocument();
  });

  it("keeps rejection reversible without enabling analytics", async () => {
    const user = userEvent.setup();
    render(
      <AnalyticsConsentManager consentRequired initialConsent={null}>
        <div>App content</div>
      </AnalyticsConsentManager>,
    );

    await user.click(screen.getByRole("button", { name: "Reject analytics" }));

    await waitFor(() =>
      expect(mockSaveAnalyticsConsent).toHaveBeenCalledWith("declined"),
    );
    expect(screen.getByTestId("posthog-provider")).toHaveAttribute(
      "data-analytics-allowed",
      "false",
    );
    expect(
      screen.getByRole("button", { name: "Privacy choices" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Privacy choices" }));
    expect(
      screen.getByRole("button", { name: "Reject analytics" }),
    ).toHaveAttribute("aria-pressed", "true");
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
        <div>App content</div>
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

    await user.click(screen.getByRole("button", { name: "Privacy choices" }));
    expect(
      screen.getByRole("button", { name: "Allow analytics" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps analytics blocked and reports a failed save", async () => {
    mockSaveAnalyticsConsent.mockRejectedValue(new Error("network"));
    const user = userEvent.setup();
    render(
      <AnalyticsConsentManager consentRequired initialConsent={null}>
        <div>App content</div>
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
        <div>App content</div>
      </AnalyticsConsentManager>,
    );

    expect(screen.queryByText("Your analytics choice")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Privacy choices" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("posthog-provider")).toHaveAttribute(
      "data-analytics-allowed",
      "true",
    );
  });
});
