import "@testing-library/jest-dom";
import { beforeEach, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react";
import { resetMockConvexQueries, setMockQueryResult } from "convex/react";
const mockOpen = jest.fn();
const mockContent = jest.fn();
jest.mock("@/app/hooks/useToolSidebar", () => ({
  useToolSidebar: ({ content }: any) => {
    mockContent(content);
    return {
      handleOpenInSidebar: mockOpen,
      handleKeyDown: jest.fn(),
      isSidebarActive: false,
    };
  },
}));
jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: jest.fn(),
}));
const { ReportToolHandler } = require("../ReportToolHandler");
const report = {
  finding_id: "finding-1",
  title: "Corrected report",
  target: "lab.test",
  severity: "high",
  cvss_score: 7.1,
};
beforeEach(() => {
  jest.clearAllMocks();
  resetMockConvexQueries();
  setMockQueryResult(undefined);
});
it("shows a bounded linked list and pagination hint without full report bodies", () => {
  render(
    <ReportToolHandler
      status="ready"
      toolName="list_reports"
      part={{
        state: "output-available",
        output: { success: true, reports: [report], is_done: false },
      }}
    />,
  );
  expect(screen.getByRole("link", { name: report.title })).toHaveAttribute(
    "href",
    "/findings?finding=finding-1",
  );
  expect(
    screen.getByText("More reports are available in this chat."),
  ).toBeVisible();
});
it.each(["get_report", "update_vulnerability_report"])(
  "opens the same report card for %s, including compact history",
  (toolName) => {
    render(
      <ReportToolHandler
        status="ready"
        toolName={toolName}
        part={{
          toolCallId: "tool-1",
          state: "output-available",
          output:
            toolName === "get_report"
              ? {
                  success: true,
                  report: { ...report, evidence: "private proof" },
                }
              : { success: true, ...report },
        }}
      />,
    );
    expect(screen.queryByText("private proof")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Open finding: Corrected report" }),
    );
    expect(mockOpen).toHaveBeenCalledTimes(1);
  },
);
it.each([
  "conflict",
  "evidence",
  "validation",
  "duplicate",
  "not_found",
  "general",
])("shows safe recovery details for %s", (reason) => {
  render(
    <ReportToolHandler
      status="ready"
      toolName="update_vulnerability_report"
      part={{
        toolCallId: "tool-1",
        state: "output-available",
        output: {
          success: false,
          error: reason === "evidence" ? "validation" : reason,
          validation_kind: reason === "evidence" ? "evidence" : undefined,
          message: "private raw payload",
        },
      }}
    />,
  );
  expect(screen.queryByText("private raw payload")).toBeNull();
  expect(mockContent).toHaveBeenCalledWith(
    expect.objectContaining({
      action: "Report update needs attention",
      summary: expect.any(String),
      nextStep: expect.any(String),
    }),
  );
});
it("renders update progress and does not claim a malformed success", () => {
  const { rerender } = render(
    <ReportToolHandler
      status="streaming"
      toolName="update_vulnerability_report"
      part={{ state: "input-available" }}
    />,
  );
  expect(screen.getByText("Updating vulnerability report")).toBeVisible();
  rerender(
    <ReportToolHandler
      status="ready"
      toolName="update_vulnerability_report"
      part={{ state: "output-available", output: { success: true } }}
    />,
  );
  expect(screen.queryByText("Report updated")).toBeNull();
});
