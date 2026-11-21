import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  resetMockConvexQueries,
  setMockQueryResult,
  useConvex as useConvexMock,
} from "convex/react";

const useConvex = useConvexMock as unknown as () => { query: jest.Mock };

const mockOpenInSidebar = jest.fn();
const mockHandleKeyDown = jest.fn();
const mockCapture = jest.fn();
const mockSidebarContent = jest.fn();

jest.mock("@/app/hooks/useToolSidebar", () => ({
  useToolSidebar: ({ content }: any) => {
    mockSidebarContent(content);
    return {
      handleOpenInSidebar: mockOpenInSidebar,
      handleKeyDown: mockHandleKeyDown,
      isSidebarActive: false,
    };
  },
}));

jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: mockCapture,
}));

const mockDownload = jest.fn();
jest.mock("@/lib/findings/export-client", () => ({
  downloadFindingsReport: (...args: unknown[]) => mockDownload(...args),
}));
jest.mock("@/lib/findings/client-telemetry", () => ({
  captureFindingEvent: jest.fn(),
}));

const { FindingToolHandler } =
  require("../FindingToolHandler") as typeof import("../FindingToolHandler");

const successPart = {
  toolCallId: "tool-1",
  state: "output-available",
  input: { title: "Confirmed IDOR", target: "app.example.test" },
  output: {
    success: true,
    finding_id: "finding-1",
    title: "Confirmed IDOR",
    target: "app.example.test",
    endpoint: "/api/invoices/other",
    severity: "high",
    cvss_score: 7.1,
  },
};

describe("FindingToolHandler", () => {
  beforeEach(() => {
    resetMockConvexQueries();
    jest.clearAllMocks();
  });

  it("renders streaming input and available input states", () => {
    const { rerender } = render(
      <FindingToolHandler
        status="streaming"
        part={{ toolCallId: "tool-1", state: "input-streaming" }}
      />,
    );
    expect(screen.getByText("Preparing vulnerability report")).toBeVisible();

    rerender(
      <FindingToolHandler
        status="streaming"
        part={{
          toolCallId: "tool-1",
          state: "input-available",
          input: { title: "Confirmed IDOR" },
        }}
      />,
    );
    expect(screen.getByText("Saving finding")).toBeVisible();
    expect(screen.getByText("Confirmed IDOR")).toBeVisible();
  });

  it("renders a saved card, preserves it across remount, and opens on click", () => {
    setMockQueryResult(undefined);
    const first = render(
      <FindingToolHandler status="ready" part={successPart} />,
    );
    expect(screen.getByText("Confirmed IDOR")).toBeVisible();
    expect(screen.getByText("/api/invoices/other")).toBeVisible();
    expect(screen.getByText(/high · 7\.1/i)).toBeVisible();

    fireEvent.click(
      screen.getByRole("button", { name: "Open finding: Confirmed IDOR" }),
    );
    expect(mockOpenInSidebar).toHaveBeenCalledTimes(1);
    expect(mockCapture).toHaveBeenCalledWith("finding_viewed", {
      surface: "inline_card",
    });

    first.unmount();
    render(<FindingToolHandler status="ready" part={successPart} />);
    expect(screen.getByText("Confirmed IDOR")).toBeVisible();
  });

  it.each(["validation", "general"])(
    "shows safe, expandable details for %s failures",
    (error) => {
      render(
        <FindingToolHandler
          status="ready"
          part={{
            toolCallId: "tool-1",
            state: "output-available",
            output: { success: false, error, message: "Private raw error" },
          }}
        />,
      );
      expect(
        screen.getByText("Vulnerability report wasn’t saved"),
      ).toBeVisible();
      expect(screen.getByText("View details")).toBeVisible();
      expect(screen.queryByText("Private raw error")).not.toBeInTheDocument();

      fireEvent.click(
        screen.getByRole("button", {
          name: "Open vulnerability report error details",
        }),
      );
      expect(mockOpenInSidebar).toHaveBeenCalledTimes(1);

      fireEvent.keyDown(
        screen.getByRole("button", {
          name: "Open vulnerability report error details",
        }),
        { key: "Escape" },
      );
      expect(mockHandleKeyDown).toHaveBeenCalledTimes(1);
    },
  );

  it("links a duplicate to the existing finding without showing an error", () => {
    render(
      <FindingToolHandler
        status="ready"
        part={{
          toolCallId: "tool-1",
          state: "output-available",
          output: {
            success: false,
            error: "duplicate",
            duplicate_of: "existing-finding",
            message: "Already saved in this chat",
          },
        }}
      />,
    );
    expect(screen.getByText("Already reported")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Open existing finding" }),
    ).toHaveAttribute("href", "/findings?finding=existing-finding");
    expect(
      screen.queryByText("Already saved in this chat"),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("keeps legacy duplicate responses without an ID informational", () => {
    render(
      <FindingToolHandler
        status="ready"
        part={{
          state: "output-available",
          output: { success: false, error: "duplicate" },
        }}
      />,
    );
    expect(screen.getByText("Already reported")).toBeVisible();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("opens actionable evidence details without leaking the raw path or payload", () => {
    render(
      <FindingToolHandler
        status="ready"
        part={{
          toolCallId: "tool-evidence",
          state: "output-available",
          output: {
            success: false,
            error: "validation",
            validation_kind: "evidence",
            message: "Private capture missing: /private/customer/request.http",
          },
        }}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Open vulnerability report error details",
      }),
    );
    const content = mockSidebarContent.mock.calls.at(-1)?.[0] as any;
    expect(content.summary).toContain("missing or inaccessible");
    expect(content.nextStep).toContain("restore any missing captures");
    expect(JSON.stringify(content)).not.toMatch(
      /private|customer|request\.http/,
    );
    expect(mockOpenInSidebar).toHaveBeenCalledTimes(1);
  });

  it("never exposes framework validation payloads inline", () => {
    const rawError =
      'Invalid input for tool create_vulnerability_report: Type validation failed: Value: {"poc_script_code":"private exploit"}';
    render(
      <FindingToolHandler
        status="ready"
        part={{
          toolCallId: "tool-1",
          state: "output-error",
          errorText: rawError,
        }}
      />,
    );
    expect(screen.getByText("Vulnerability report wasn’t saved")).toBeVisible();
    expect(screen.getByText("View details")).toBeVisible();
    expect(screen.queryByText(rawError)).not.toBeInTheDocument();
    expect(screen.queryByText(/private exploit/i)).not.toBeInTheDocument();
  });

  it("reactively replaces a card with the deleted state", () => {
    setMockQueryResult(undefined);
    const { rerender } = render(
      <FindingToolHandler status="ready" part={successPart} />,
    );
    expect(screen.getByText("Confirmed IDOR")).toBeVisible();

    setMockQueryResult(null);
    rerender(<FindingToolHandler status="ready" part={{ ...successPart }} />);
    expect(screen.getByText("Finding deleted")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /Open finding/i }),
    ).not.toBeInTheDocument();
  });
});

describe("saved decision on the exact linked card", () => {
  const dismissedReason = "Synthetic public help text, not sensitive data.";
  // The transcript recorded High; the current saved record is dismissed.
  const liveDismissed = {
    finding_id: "finding-1",
    title: "Sensitive data shown in help text",
    target: "demo.example.test",
    endpoint: "/onboarding/overview",
    severity: "medium",
    cvss_score: 5.3,
    status: "closed",
    closure_reason: "false_positive",
    closure_context: dismissedReason,
    closed_at: Date.UTC(2026, 10, 19, 15, 2),
    disposition: {
      kind: "dismissed",
      label: "Dismissed",
      reason: dismissedReason,
      decided_at: Date.UTC(2026, 10, 19, 15, 2),
    },
    updated_at: 3,
  };

  beforeEach(() => {
    resetMockConvexQueries();
    jest.clearAllMocks();
  });

  it("shows the current decision, exact reason and evidence label, keeping the tool input intact", () => {
    setMockQueryResult(liveDismissed);
    render(<FindingToolHandler status="ready" part={successPart} />);
    expect(screen.getByText("Sensitive data shown in help text")).toBeVisible();
    expect(screen.getByText("Dismissed")).toBeVisible();
    expect(screen.getByText(dismissedReason)).toBeVisible();
    expect(screen.getByText("Not recorded")).toBeVisible();
    expect(screen.getByText("Reported Medium · 5.3")).toBeVisible();
    // The snapshot severity is not replayed as current.
    expect(screen.queryByText(/high · 7\.1/i)).not.toBeInTheDocument();
    expect(successPart.output.title).toBe("Confirmed IDOR");
  });

  it("labels an active correction and keeps an inconclusive evidence basis distinct", () => {
    setMockQueryResult({
      ...liveDismissed,
      status: "active",
      severity: "low",
      cvss_score: 3.1,
      evidence_status: "inconclusive",
      disposition: {
        kind: "corrected",
        label: "Corrected",
        reason: "Error text is a code, not a stack trace.",
        decided_at: 4,
      },
    });
    render(<FindingToolHandler status="ready" part={successPart} />);
    expect(screen.getAllByText("Corrected")[0]).toBeVisible();
    expect(
      screen.getByText("Error text is a code, not a stack trace."),
    ).toBeVisible();
    expect(screen.getByText("Inconclusive")).toBeVisible();
    expect(screen.getByText(/low · 3\.1/i)).toBeVisible();
  });

  it.each([
    ["loading", undefined],
    ["unavailable", null],
    ["failed", new Error("Function execution timed out")],
  ])("never guesses a decision or offers export while %s", (_state, result) => {
    setMockQueryResult(result);
    render(<FindingToolHandler status="ready" part={successPart} />);
    expect(screen.queryByText("Dismissed")).not.toBeInTheDocument();
    expect(screen.queryByText("Corrected")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Download PDF/ }),
    ).not.toBeInTheDocument();
  });

  it("downloads a PDF of the freshly read record, not the rendered snapshot", async () => {
    const fresh = {
      ...liveDismissed,
      closure_context: "Reason saved after this card rendered.",
      updated_at: 9,
    };
    useConvex().query.mockResolvedValueOnce(fresh as never);
    mockDownload.mockResolvedValueOnce({ outcome: "success" } as never);
    setMockQueryResult(liveDismissed);
    render(<FindingToolHandler status="ready" part={successPart} />);

    fireEvent.click(screen.getByRole("button", { name: "Download PDF" }));
    await waitFor(() =>
      expect(mockDownload).toHaveBeenCalledWith([fresh], "pdf"),
    );
    expect(useConvex().query.mock.calls[0][1]).toEqual({
      findingId: "finding-1",
    });
  });

  it("exports nothing when the fresh read finds no authorized record", async () => {
    useConvex().query.mockResolvedValueOnce(null as never);
    setMockQueryResult(liveDismissed);
    render(<FindingToolHandler status="ready" part={successPart} />);
    fireEvent.click(screen.getByRole("button", { name: "Download PDF" }));
    await waitFor(() => expect(useConvex().query).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Download PDF" }),
      ).toBeEnabled(),
    );
    expect(mockDownload).not.toHaveBeenCalled();
  });
});

it("keeps the saved card and surrounding chat visible when its live query fails", () => {
  setMockQueryResult(new Error("Function execution timed out"));
  const { rerender } = render(
    <div>
      <p>Completed chat remains visible</p>
      <FindingToolHandler part={successPart} status="ready" />
    </div>,
  );
  expect(screen.getByText("Completed chat remains visible")).toBeVisible();
  expect(screen.getByText("Confirmed IDOR")).toBeVisible();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "temporarily unavailable",
  );
  expect(screen.queryByText("Finding deleted")).not.toBeInTheDocument();

  setMockQueryResult({ title: "Updated saved finding", severity: "high" });
  rerender(<FindingToolHandler part={successPart} status="ready" />);
  expect(screen.getByText("Updated saved finding")).toBeVisible();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  resetMockConvexQueries();
});
