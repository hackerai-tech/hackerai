import "@testing-library/jest-dom";
import { beforeEach, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react";
const mockContent = jest.fn();
jest.mock("@/app/hooks/useToolSidebar", () => ({
  useToolSidebar: ({ content }: any) => {
    mockContent(content);
    return {
      handleOpenInSidebar: jest.fn(),
      handleKeyDown: jest.fn(),
      isSidebarActive: false,
    };
  },
}));
const { FindingRetestToolHandler } = require("../FindingRetestToolHandler");

const completeInput = {
  finding_id: "finding-1",
  outcome: "not_reproduced",
  summary: "private summary",
  observed_result: "private observation",
  reproduction_steps: ["private step"],
  expected_result: "private expectation",
  limitations: ["private limitation"],
};

beforeEach(() => jest.clearAllMocks());

it("says a saved completion is the Agent's assessment and links to its finding", () => {
  render(
    <FindingRetestToolHandler
      status="ready"
      toolName="complete_finding_retest"
      part={{
        toolCallId: "t1",
        state: "output-available",
        input: completeInput,
        output: { success: true, retest_id: "r1", duplicate: false },
      }}
    />,
  );
  expect(screen.getByText("Agent assessment saved")).toBeVisible();
  expect(screen.getAllByText("Not reproduced").length).toBeGreaterThan(0);
  expect(
    screen.getAllByText(/The report wasn.t\s+changed/).length,
  ).toBeGreaterThan(0);
  expect(screen.getByRole("link", { name: /View finding/ })).toHaveAttribute(
    "href",
    "/findings?finding=finding-1",
  );
  // The card summarizes; it never dumps the assessment text into the chat.
  expect(screen.queryByText(/private/)).toBeNull();
});

it("shows a started retest as pending, never as an outcome", () => {
  render(
    <FindingRetestToolHandler
      status="ready"
      toolName="start_finding_retest"
      part={{
        state: "output-available",
        input: { finding_id: "finding-1", expected_updated_at: 1 },
        output: { success: true, retest_id: "r1", duplicate: false },
      }}
    />,
  );
  expect(screen.getByText("Retest started")).toBeVisible();
  expect(screen.getByText("Result pending")).toBeVisible();
  expect(screen.queryByText(/Reproduced|Not reproduced|saved/i)).toBeNull();
});

it.each([
  ["start_finding_retest", "not_active", "Retest wasn't started"],
  ["complete_finding_retest", "validation", "Agent assessment wasn't saved"],
  ["complete_finding_retest", "interrupted", "Agent assessment wasn't saved"],
  ["get_finding_retests", "general", "Retest history unavailable"],
])(
  "shows safe recovery for %s %s without raw tool text",
  (toolName, error, action) => {
    render(
      <FindingRetestToolHandler
        status="ready"
        toolName={toolName}
        part={{
          toolCallId: "t1",
          state: "output-available",
          input: { ...completeInput, observed_result: "Cookie: secret-value" },
          output: { success: false, error, message: "private raw message" },
        }}
      />,
    );
    expect(screen.getByText(action)).toBeVisible();
    const content = mockContent.mock.calls.at(-1)?.[0] as any;
    expect(JSON.stringify(content)).not.toMatch(/private|secret-value/);
    expect(content).toMatchObject({ summary: expect.any(String) });
    if (error === "interrupted")
      expect(content.summary).toContain("Inconclusive");
  },
);

it("shows progress only while streaming and nothing for a stopped call", () => {
  const { rerender } = render(
    <FindingRetestToolHandler
      status="streaming"
      toolName="complete_finding_retest"
      part={{ state: "input-available", input: completeInput }}
    />,
  );
  expect(screen.getByText("Saving Agent assessment")).toBeVisible();
  rerender(
    <FindingRetestToolHandler
      status="ready"
      toolName="complete_finding_retest"
      part={{ state: "input-available", input: completeInput }}
    />,
  );
  expect(screen.queryByText("Saving Agent assessment")).toBeNull();
  expect(screen.queryByText("Agent assessment saved")).toBeNull();
});
