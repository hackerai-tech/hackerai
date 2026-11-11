import { fireEvent, render, screen, within } from "@testing-library/react";
import { FindingAgentRetests } from "../FindingAgentRetests";
import { getDraftContentById } from "@/lib/utils/client-storage";
import type {
  FindingAgentRetestView,
  FindingDetailRecord,
  FindingRetestState,
} from "@/types/finding";

const push = jest.fn();
const setChatMode = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => "/findings",
}));
jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({ closeSidebar: jest.fn(), setChatMode }),
}));
jest.mock("@/app/contexts/ComposerState", () => ({
  useComposerActions: () => ({ getInput: () => "", setInput: jest.fn() }),
}));
jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: jest.fn(),
}));

const finding = {
  finding_id: "finding-1",
  chat_id: "chat-1",
  updated_at: 10,
  status: "active",
} as FindingDetailRecord;

const retest = (
  overrides: Partial<FindingAgentRetestView> = {},
): FindingAgentRetestView => ({
  retest_id: "r1",
  chat_id: "chat-1",
  assistant_message_id: "message-1",
  status: "finished",
  started_at: Date.now() - 60_000,
  finished_at: Date.now() - 30_000,
  outcome: "reproduced",
  summary: "Tester could still read another account's invoice.",
  reproduction_steps: ["Load own invoice", "Load the other invoice"],
  expected_result: "403 for the other account's invoice",
  observed_result: "200 with owner_id usr_victim_a",
  evidence_refs: ["/tmp/retest/other.txt"],
  evidence_verification: {
    checked_refs: ["/tmp/retest/other.txt"],
    unavailable_refs: [],
  },
  limitations: ["Write endpoints were not retested."],
  environment: { kind: "local", name: "MacBook Pro" },
  ...overrides,
});

const state = (
  retests: FindingAgentRetestView[],
): Extract<FindingRetestState, { enabled: true }> => ({
  enabled: true,
  chat_title: "Demo shop fixture scan",
  retests,
});

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
});

it("shows the latest Agent assessment with evidence, limits and source links", () => {
  render(
    <FindingAgentRetests
      finding={finding}
      state={state([
        retest(),
        retest({
          retest_id: "r0",
          assistant_message_id: "message-0",
          outcome: "not_reproduced",
          summary: "Cross-account read was denied.",
        }),
      ])}
    />,
  );
  const latest = screen.getByRole("article", {
    name: "Latest Agent assessment: Reproduced",
  });
  expect(within(latest).getByText("Agent assessment · latest")).toBeVisible();
  expect(within(latest).getByText("Load the other invoice")).toBeVisible();
  expect(
    within(latest).getByText("200 with owner_id usr_victim_a"),
  ).toBeVisible();
  expect(within(latest).getByText("File found")).toBeVisible();
  expect(
    within(latest).getByText("Write endpoints were not retested."),
  ).toBeVisible();
  expect(
    within(latest).getByRole("link", { name: /Open in task/ }),
  ).toHaveAttribute("href", "/c/chat-1#message=message-1");
  expect(screen.getByText("Retest history")).toBeVisible();
  expect(
    screen.getByRole("link", { name: "View Not reproduced in task" }),
  ).toHaveAttribute("href", "/c/chat-1#message=message-0");
  expect(screen.getByText(/not independent/)).toBeVisible();
  // Agent-only: no HTTP recipe, request editor or credential inputs.
  expect(screen.queryByText(/recipe/i)).toBeNull();
  expect(document.querySelector("input")).toBeNull();
  expect(screen.getAllByRole("button")).toHaveLength(1);
});

it("prepares a recorded retest draft in the source task without sending it", () => {
  render(<FindingAgentRetests finding={finding} state={state([])} />);
  expect(screen.getByText("No retests yet")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Retest with Agent" }));
  const draft = getDraftContentById("chat-1") ?? "";
  expect(draft).toContain("start_finding_retest");
  expect(draft).toContain("complete_finding_retest");
  expect(push).toHaveBeenCalledWith("/c/chat-1");
  expect(setChatMode).toHaveBeenCalledWith("agent");
});

it("shows running only for a recorded live run and blocks a second retest", () => {
  render(
    <FindingAgentRetests
      finding={finding}
      state={state([
        retest({
          status: "running",
          outcome: undefined,
          finished_at: undefined,
        }),
      ])}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Agent is retesting");
  expect(
    screen.getByRole("button", { name: "Retest running…" }),
  ).toBeDisabled();
  expect(screen.getByRole("link", { name: /Watch in task/ })).toHaveAttribute(
    "href",
    "/c/chat-1",
  );
});

it("presents an interrupted run as inconclusive, never as fixed", () => {
  render(
    <FindingAgentRetests
      finding={finding}
      state={state([
        retest({
          outcome: "inconclusive",
          interrupted: true,
          summary: undefined,
          reproduction_steps: undefined,
          expected_result: undefined,
          observed_result: undefined,
          evidence_refs: undefined,
          evidence_verification: undefined,
          limitations: undefined,
        }),
      ])}
    />,
  );
  const latest = screen.getByRole("article", {
    name: "Latest Agent assessment: Inconclusive",
  });
  expect(latest).toHaveTextContent("doesn't show the issue is fixed");
  expect(
    screen.getByRole("button", { name: "Retest with Agent" }),
  ).toBeEnabled();
});
