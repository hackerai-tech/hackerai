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
const { FindingHuntToolHandler } = require("../FindingHuntToolHandler");

const privateCandidate = {
  finding_id: "finding-1",
  candidate_key: "private-key",
  surface: "private /api/internal/path",
  rationale: "private rationale",
  outcome: "ruled_out",
  observed_result: "private observation",
  limitations: ["private limitation"],
};

beforeEach(() => jest.clearAllMocks());

it("shows a saved candidate's outcome without dumping its content", () => {
  render(
    <FindingHuntToolHandler
      status="ready"
      toolName="record_finding_hunt_candidate"
      part={{
        toolCallId: "t1",
        state: "output-available",
        input: privateCandidate,
        output: {
          success: true,
          hunt_id: "h1",
          candidate_count: 1,
          duplicate: false,
        },
      }}
    />,
  );
  expect(screen.getByText("Candidate saved")).toBeVisible();
  expect(screen.getByText("Ruled out")).toBeVisible();
  expect(screen.queryByText(/private/)).toBeNull();
});

it("summarizes a completed hunt with server counts and links to its finding", () => {
  render(
    <FindingHuntToolHandler
      status="ready"
      toolName="complete_finding_hunt"
      part={{
        toolCallId: "t1",
        state: "output-available",
        input: {
          finding_id: "finding-1",
          summary: "private summary",
          limitations: ["private"],
        },
        output: {
          success: true,
          hunt_id: "h1",
          duplicate: false,
          counts: {
            reproduced: 2,
            ruled_out: 1,
            inconclusive: 0,
            not_examined: 1,
          },
        },
      }}
    />,
  );
  expect(screen.getByText("Hunt saved")).toBeVisible();
  expect(screen.getByText("2 reproduced")).toBeVisible();
  expect(screen.getByText("1 not examined")).toBeVisible();
  expect(screen.queryByText(/inconclusive/)).toBeNull();
  expect(screen.getByText(/Not findings; the report wasn.t/)).toBeVisible();
  expect(screen.getByRole("link", { name: /View finding/ })).toHaveAttribute(
    "href",
    "/findings?finding=finding-1",
  );
  expect(screen.queryByText(/private/)).toBeNull();
});

it("shows a started hunt as pending, never as a result", () => {
  render(
    <FindingHuntToolHandler
      status="ready"
      toolName="start_finding_hunt"
      part={{
        state: "output-available",
        input: { finding_id: "finding-1", expected_updated_at: 1 },
        output: { success: true, hunt_id: "h1", duplicate: false },
      }}
    />,
  );
  expect(screen.getByText("Hunt started")).toBeVisible();
  expect(screen.getByText("Results pending")).toBeVisible();
  expect(screen.queryByText(/Reproduced|Ruled out|saved/i)).toBeNull();
});

it.each([
  ["start_finding_hunt", "not_active", "Hunt wasn't started"],
  ["record_finding_hunt_candidate", "validation", "Candidate wasn't saved"],
  ["record_finding_hunt_candidate", "interrupted", "Candidate wasn't saved"],
  ["complete_finding_hunt", "conflict", "Hunt summary wasn't saved"],
  ["get_finding_hunts", "general", "Hunt history unavailable"],
])(
  "shows safe recovery for %s %s without raw tool text",
  (toolName, error, action) => {
    render(
      <FindingHuntToolHandler
        status="ready"
        toolName={toolName}
        part={{
          toolCallId: "t1",
          state: "output-available",
          input: { ...privateCandidate, observed_result: "Cookie: secret-v" },
          output: { success: false, error, message: "private raw message" },
        }}
      />,
    );
    expect(screen.getByText(action)).toBeVisible();
    const content = mockContent.mock.calls.at(-1)?.[0] as any;
    expect(JSON.stringify(content)).not.toMatch(/private|secret-v/);
    if (error === "interrupted") expect(content.summary).toContain("were kept");
  },
);

it("tells a mounted finding view only about hunt writes that actually saved", () => {
  const { subscribeFindingHuntChanges } = require("@/lib/findings/hunt-events");
  const changed = jest.fn();
  const unsubscribe = subscribeFindingHuntChanges(changed);
  try {
    const part = (state: string, output?: unknown) => ({
      toolCallId: "t1",
      state,
      input: { finding_id: "finding-1", expected_updated_at: 1 },
      output,
    });
    const { rerender } = render(
      <FindingHuntToolHandler
        status="streaming"
        toolName="start_finding_hunt"
        part={part("input-available")}
      />,
    );
    expect(changed).not.toHaveBeenCalled();
    rerender(
      <FindingHuntToolHandler
        status="ready"
        toolName="start_finding_hunt"
        part={part("output-available", { success: true, hunt_id: "h1" })}
      />,
    );
    // Only the finding ID is shared.
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledWith("finding-1");

    changed.mockClear();
    for (const [toolName, output] of [
      ["start_finding_hunt", { success: false, error: "busy" }],
      ["record_finding_hunt_candidate", { success: false, error: "general" }],
      ["get_finding_hunts", { success: true, hunts: [] }],
    ] as const)
      render(
        <FindingHuntToolHandler
          status="ready"
          toolName={toolName}
          part={part("output-available", output)}
        />,
      );
    expect(changed).not.toHaveBeenCalled();
  } finally {
    unsubscribe();
  }
});

it("shows progress only while streaming", () => {
  const { rerender } = render(
    <FindingHuntToolHandler
      status="streaming"
      toolName="record_finding_hunt_candidate"
      part={{ state: "input-available", input: privateCandidate }}
    />,
  );
  expect(screen.getByText("Saving candidate assessment")).toBeVisible();
  rerender(
    <FindingHuntToolHandler
      status="ready"
      toolName="record_finding_hunt_candidate"
      part={{ state: "input-available", input: privateCandidate }}
    />,
  );
  expect(screen.queryByText("Saving candidate assessment")).toBeNull();
});
