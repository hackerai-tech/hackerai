jest.mock("@/app/posthog", () => ({ __esModule: true, default: jest.fn() }));
import PostHogClient from "@/app/posthog";
import { captureGoalLifecycle } from "../analytics";
import type { Doc } from "@/convex/_generated/dataModel";

const capture = jest.fn();
const shutdown = jest.fn();
const context = { userId: "owner", chatId: "chat", runId: "run" };
const goal = {
  _id: "goal",
  _creationTime: 100,
  startedAt: 100,
  updatedAt: 300,
  generation: 2,
  state: "paused",
  elapsedMs: 200,
  activeSince: undefined,
  objective: "PRIVATE OBJECTIVE",
  criteria: ["PRIVATE CRITERION", "SECOND"],
  evidence: [
    { criterion: 0, explanation: "PRIVATE EVIDENCE" },
    { criterion: 0, explanation: "PRIVATE EVIDENCE" },
  ],
  verificationCommand: "PRIVATE COMMAND",
  reason: "PRIVATE REASON",
  sandboxPreference: "e2b",
  runs: 2,
  maxRuns: 5,
  noProgressRuns: 0,
  permissionMode: "full_access",
} as unknown as Doc<"agent_goals">;

beforeEach(() => {
  jest.clearAllMocks();
  shutdown.mockReset().mockResolvedValue(undefined);
  capture.mockReset();
  (PostHogClient as jest.Mock)
    .mockReset()
    .mockReturnValue({ capture, shutdown });
});

test("captures diagnostic identifiers and cumulative time without goal content", async () => {
  await captureGoalLifecycle("settled", context, goal);
  const event = capture.mock.calls[0][0];
  expect(event.properties).toMatchObject({
    goal_attempt_id: "goal:100",
    goal_generation: 2,
    trigger_run_id: "run",
    state: "paused",
    elapsed_ms: 200,
    criteria_count: 2,
    verified_criteria_count: 1,
    evidence_count: 2,
    has_verification_command: true,
    sandbox_type: "cloud",
  });
  expect(JSON.stringify(event)).not.toContain("PRIVATE");
  expect(event.properties).not.toHaveProperty("objective");
  expect(event.properties).not.toHaveProperty("reason");
  expect(shutdown).toHaveBeenCalledWith(1000);
});

test("deduplicates retries but distinguishes generations and new goal attempts", async () => {
  await captureGoalLifecycle("settled", context, goal);
  await captureGoalLifecycle("settled", context, goal);
  await captureGoalLifecycle("settled", context, { ...goal, generation: 3 });
  await captureGoalLifecycle("settled", context, { ...goal, startedAt: 500 });
  const ids = capture.mock.calls.map(([event]) => event.uuid);
  expect(ids[0]).toEqual(ids[1]);
  expect(new Set(ids).size).toBe(3);
});

test("records pre-snapshot failures without inventing persisted state", async () => {
  await captureGoalLifecycle("dispatch_failed", {
    ...context,
    goalGeneration: 4,
  });
  expect(capture.mock.calls[0][0].properties).toMatchObject({
    action: "dispatch_failed",
    goal_generation: 4,
  });
  expect(capture.mock.calls[0][0].properties.state).toBeUndefined();
});

test.each(["constructor", "capture", "shutdown-sync", "shutdown-async"])(
  "%s failure cannot fail goal execution",
  async (failure) => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    if (failure === "constructor")
      (PostHogClient as jest.Mock).mockImplementation(() => {
        throw new Error("PRIVATE SDK ERROR");
      });
    if (failure === "capture")
      capture.mockImplementation(() => {
        throw new Error("PRIVATE SDK ERROR");
      });
    if (failure === "shutdown-sync")
      shutdown.mockImplementation(() => {
        throw new Error("PRIVATE SDK ERROR");
      });
    if (failure === "shutdown-async")
      shutdown.mockRejectedValue(new Error("PRIVATE SDK ERROR"));
    await expect(
      captureGoalLifecycle("settled", context, goal),
    ).resolves.toBeUndefined();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATE");
    warn.mockRestore();
  },
);
