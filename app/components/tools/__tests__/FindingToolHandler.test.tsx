import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react";
import { resetMockConvexQueries, setMockQueryResult } from "convex/react";

const mockOpenInSidebar = jest.fn();
const mockCapture = jest.fn();

jest.mock("@/app/hooks/useToolSidebar", () => ({
  useToolSidebar: () => ({
    handleOpenInSidebar: mockOpenInSidebar,
    handleKeyDown: jest.fn(),
    isSidebarActive: false,
  }),
}));

jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: mockCapture,
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
    expect(screen.getByText("Saving confirmed finding")).toBeVisible();
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
    },
  );

  it("shows duplicate failures without opening error details", () => {
    render(
      <FindingToolHandler
        status="ready"
        part={{
          toolCallId: "tool-1",
          state: "output-available",
          output: {
            success: false,
            error: "duplicate",
            message: "Already saved in this chat",
          },
        }}
      />,
    );
    expect(screen.getByText("Duplicate finding rejected")).toBeVisible();
    expect(screen.getByText("Already saved in this chat")).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
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
