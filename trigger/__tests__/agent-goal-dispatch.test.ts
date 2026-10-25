jest.mock("@trigger.dev/sdk", () => ({
  task: (config: unknown) => config,
  tasks: { trigger: jest.fn() },
  sessions: { start: jest.fn() },
}));
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({ mutation: mockMutation }),
  setConvexUrl: jest.fn(),
}));
jest.mock("@/lib/goals/server", () => ({
  getGoal: (...args: unknown[]) => mockGetGoal(...args),
  goalServiceKey: () => "synthetic",
  assertGoalExecutionAllowed: (...args: unknown[]) => mockAllowed(...args),
}));
import { sessions, tasks } from "@trigger.dev/sdk";
import {
  agentGoalDispatch,
  scheduleGoalContinuation,
} from "../agent-goal-dispatch";
import type { AgentLongPayload } from "../agent-long";
const mockMutation = jest.fn(),
  mockGetGoal = jest.fn(),
  mockAllowed = jest.fn();
const payload = {
  chatId: "chat",
  userId: "owner",
  subscription: "pro",
  convexUrl: "https://example.convex.cloud",
  goalGeneration: 2,
  goalWorkerVersion: "version1",
  approvalProtocolVersion: 2,
  sandboxPreference: "desktop",
  selectedModel: "auto",
  agentPermissionMode: "full_access",
  messages: [],
  triggerRegion: "us-west-1",
} as unknown as AgentLongPayload;
const run = (p = payload) =>
  (
    agentGoalDispatch as unknown as {
      run: (p: AgentLongPayload, o: unknown) => Promise<unknown>;
    }
  ).run(p, {
    ctx: { run: { id: "dispatcher" }, deployment: { version: "version2" } },
  });
describe("bounded goal continuation dispatch", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMutation.mockResolvedValue(true);
    mockAllowed.mockResolvedValue(undefined);
    mockGetGoal.mockResolvedValue({
      _id: "goal",
      state: "queued",
      generation: 2,
    });
    (tasks.trigger as jest.Mock).mockResolvedValue({ id: "worker" });
    (sessions.start as jest.Mock).mockResolvedValue({ runId: "worker" });
  });
  it("does no work for a stale or duplicate dispatch", async () => {
    mockMutation.mockResolvedValue(false);
    await run();
    expect(mockAllowed).not.toHaveBeenCalled();
    expect(tasks.trigger).not.toHaveBeenCalled();
  });
  it("preserves sandbox, permissions, worker version, and idempotency", async () => {
    await run();
    expect(tasks.trigger).toHaveBeenCalledWith(
      "agent-long",
      expect.objectContaining({
        sandboxPreference: "desktop",
        agentPermissionMode: "full_access",
        goalGeneration: 2,
        isAutomaticContinuation: true,
        isNewChat: false,
      }),
      expect.objectContaining({
        version: "version1",
        idempotencyKey: "goal:goal:2",
        metadata: expect.objectContaining({ chatId: "chat", userId: "owner" }),
      }),
    );
  });
  it("reopens the existing approval protocol instead of bypassing approvals", async () => {
    await run({ ...payload, agentPermissionMode: "ask_approval" });
    expect(tasks.trigger).not.toHaveBeenCalled();
    expect(sessions.start).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "agent-long-approval.v2",
        externalId: "goal:goal:2",
        triggerConfig: expect.objectContaining({
          lockToVersion: "version1",
          basePayload: expect.objectContaining({
            approvalSessionId: "goal:goal:2",
            agentPermissionMode: "ask_approval",
          }),
        }),
      }),
    );
  });
  it("fails closed if the user loses entitlement before continuation", async () => {
    mockAllowed.mockRejectedValue(new Error("Subscription changed"));
    await expect(run()).rejects.toThrow("Subscription changed");
    expect(tasks.trigger).not.toHaveBeenCalled();
    expect(mockMutation).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ generation: 2, chatId: "chat" }),
    );
  });
  it.each([
    ["replacement or manually resumed goal", undefined],
    ["another run's continuation", "newer-run"],
  ])("ignores a late success callback for a %s", async (_, sourceRunId) => {
    mockGetGoal.mockResolvedValue({
      _id: "goal",
      state: "queued",
      generation: 3,
      continuationSourceRunId: sourceRunId,
    });
    await scheduleGoalContinuation(payload, "finished-run");
    expect(tasks.trigger).not.toHaveBeenCalled();
    expect(mockMutation).not.toHaveBeenCalled();
  });
  it("honors the persisted wake time and never schedules a paused goal", async () => {
    const waitUntil = Date.now() + 60_000;
    mockGetGoal.mockResolvedValue({
      _id: "goal",
      state: "waiting",
      generation: 3,
      waitUntil,
      continuationSourceRunId: "finished-run",
    });
    await scheduleGoalContinuation(payload, "finished-run");
    expect(tasks.trigger).toHaveBeenCalledWith(
      "agent-goal-dispatch",
      expect.objectContaining({ goalGeneration: 3 }),
      expect.objectContaining({
        delay: new Date(waitUntil),
        version: "version1",
      }),
    );
    (tasks.trigger as jest.Mock).mockClear();
    mockGetGoal.mockResolvedValue({ state: "paused" });
    await scheduleGoalContinuation(payload, "finished-run");
    expect(tasks.trigger).not.toHaveBeenCalled();
  });
});
