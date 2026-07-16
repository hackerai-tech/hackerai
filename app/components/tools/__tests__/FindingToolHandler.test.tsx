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

  it.each([
    ["validation", "Finding validation failed"],
    ["duplicate", "Duplicate finding rejected"],
    ["general", "Finding was not saved"],
  ])("renders %s failures", (error, action) => {
    render(
      <FindingToolHandler
        status="ready"
        part={{
          toolCallId: "tool-1",
          state: "output-available",
          output: { success: false, error, message: "Safe error message" },
        }}
      />,
    );
    expect(screen.getByText(action)).toBeVisible();
    expect(screen.getByText("Safe error message")).toBeVisible();
  });

  it("renders tool execution errors", () => {
    render(
      <FindingToolHandler
        status="ready"
        part={{
          toolCallId: "tool-1",
          state: "output-error",
          errorText: "Invalid CVE format",
        }}
      />,
    );
    expect(screen.getByText("Finding validation failed")).toBeVisible();
    expect(screen.getByText("Invalid CVE format")).toBeVisible();
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
