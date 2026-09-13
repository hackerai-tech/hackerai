jest.mock("server-only", () => ({}));
const mockQuery = jest.fn();
const mockMutation = jest.fn();
jest.mock("../convex-client", () => ({
  getConvexClient: () => ({ query: mockQuery, mutation: mockMutation }),
}));
jest.mock("@/lib/posthog/server", () => ({ phLogger: { event: jest.fn() } }));
import { loadObjectiveCheckpoint } from "../objective-checkpoint";
import { newObjectiveCheckpoint } from "@/lib/chat/objective-checkpoint";
const args = {
  userId: "user",
  chatId: "chat",
  triggerRunId: "new-run",
  signal: new AbortController().signal,
  environment: async () => "e2b:same",
  allowFollowUp: true,
};

beforeEach(() => {
  mockQuery.mockReset();
  mockMutation.mockReset().mockResolvedValue(null);
});
it.each([true, false])(
  "only resets failed-attempt policy for explicit follow-up=%s",
  async (allowFollowUp) => {
    const saved = {
      ...newObjectiveCheckpoint("old-run"),
      unsuccessfulAttempts: 2,
      blocker: "Two failed attempts",
      spendDollars: 0.4,
      revision: 7,
    };
    mockQuery.mockResolvedValue(JSON.stringify(saved));
    const runtime = await loadObjectiveCheckpoint({ ...args, allowFollowUp });
    expect(runtime.state.unsuccessfulAttempts).toBe(allowFollowUp ? 0 : 2);
    await runtime.recordSpend(0.1);
    expect(runtime.state.spendDollars).toBe(0.5);
    expect(mockMutation.mock.calls[0][1].expectedRevision).toBe(7);
    expect(mockMutation.mock.calls[1][1].expectedRevision).toBe(8);
  },
);
it("never resets failures for another provider attempt in the same run", async () => {
  mockQuery.mockResolvedValue(
    JSON.stringify({
      ...newObjectiveCheckpoint("new-run"),
      unsuccessfulAttempts: 2,
      blocker: "No progress",
    }),
  );
  const runtime = await loadObjectiveCheckpoint(args);
  expect(runtime.state.unsuccessfulAttempts).toBe(2);
});
it("a user follow-up does not erase unknown external outcomes", async () => {
  const saved = newObjectiveCheckpoint("old-run");
  saved.unsuccessfulAttempts = 2;
  saved.actions.push({
    id: "a",
    tool: "run_terminal_cmd",
    state: "running",
    assessed: false,
  });
  mockQuery.mockResolvedValue(JSON.stringify(saved));
  const runtime = await loadObjectiveCheckpoint(args);
  expect(runtime.state.blocker).toContain("unknown outcome");
  expect(runtime.state.actions[0].state).toBe("outcome_unknown");
});
