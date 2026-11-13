import { fireEvent, render, screen, within } from "@testing-library/react";
import { FindingAgentRetests } from "../FindingAgentRetests";
import type {
  FindingAgentRetestView,
  FindingRetestState,
} from "@/types/finding";

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

it("keeps every retest in compact history and shows evidence, limits and source on demand", () => {
  render(
    <FindingAgentRetests
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
  expect(
    screen.getByText("Tester could still read another account's invoice."),
  ).toBeVisible();
  expect(screen.getByText("Cross-account read was denied.")).toBeVisible();
  expect(screen.getByText(/not independent certification/)).toBeVisible();
  // Collapsed by default.
  expect(screen.queryByText("Load the other invoice")).toBeNull();

  fireEvent.click(
    screen.getByRole("button", { name: "Reproduced retest details" }),
  );
  const latest = screen
    .getByRole("button", { name: "Reproduced retest details" })
    .closest("li")!;
  expect(within(latest).getByText("Load the other invoice")).toBeVisible();
  expect(
    within(latest).getByText("200 with owner_id usr_victim_a"),
  ).toBeVisible();
  expect(within(latest).getByText("File found")).toBeVisible();
  expect(
    within(latest).getByText("Write endpoints were not retested."),
  ).toBeVisible();
  expect(within(latest).getByText("Local sandbox (MacBook Pro)")).toBeVisible();
  expect(
    within(latest).getByRole("link", { name: /Open in task/ }),
  ).toHaveAttribute("href", "/c/chat-1#message=message-1");

  fireEvent.click(
    screen.getByRole("button", { name: "Not reproduced retest details" }),
  );
  expect(
    screen
      .getAllByRole("link", { name: /Open in task/ })
      .map((link) => link.getAttribute("href")),
  ).toContain("/c/chat-1#message=message-0");
  // Agent-only: no HTTP recipe, request editor, credential input or CTA here.
  expect(screen.queryByText(/recipe/i)).toBeNull();
  expect(document.querySelector("input")).toBeNull();
  expect(
    screen.queryByRole("button", { name: /Retest with Agent/ }),
  ).toBeNull();
});

it("explains an empty history without its own action", () => {
  render(<FindingAgentRetests state={state([])} />);
  expect(screen.getByText("No retests yet")).toBeVisible();
  expect(screen.getByText(/never as fixed/)).toBeVisible();
  expect(screen.queryByRole("button")).toBeNull();
});

it("shows running only for a recorded live run with a watch link", () => {
  render(
    <FindingAgentRetests
      state={state([
        retest({
          status: "running",
          outcome: undefined,
          finished_at: undefined,
        }),
      ])}
    />,
  );
  const row = screen.getByRole("button", { name: "Running retest details" });
  expect(row).toHaveTextContent("Agent is retesting");
  fireEvent.click(row);
  expect(screen.getByRole("link", { name: /Watch in task/ })).toHaveAttribute(
    "href",
    "/c/chat-1",
  );
});

it("presents an interrupted run as inconclusive, never as fixed", () => {
  render(
    <FindingAgentRetests
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
  expect(
    screen.getByRole("button", { name: "Inconclusive retest details" }),
  ).toHaveTextContent("doesn't show the issue is fixed");
});
