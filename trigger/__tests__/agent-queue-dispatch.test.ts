jest.mock("@/convex/_generated/api", () => ({
  api: {
    queuedMessages: {
      claimNextForDispatch: "claim",
      getClaimedForDispatch: "getClaimed",
      releaseDispatch: "release",
      completeDispatch: "complete",
    },
  },
}));
jest.mock("@trigger.dev/sdk", () => ({
  task: (config: unknown) => config,
  tasks: { trigger: jest.fn() },
}));
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({ mutation: mockMutation, query: mockQuery }),
  setConvexUrl: jest.fn(),
}));
jest.mock("@/lib/db/actions", () => ({
  getChatById: (...args: unknown[]) => mockGetChat(...args),
  getCurrentAgentEntitlementContext: (...args: unknown[]) =>
    mockEntitlement(...args),
  handleInitialChatAndUserMessage: (...args: unknown[]) =>
    mockSaveMessage(...args),
}));
jest.mock("@/lib/suspensions", () => ({
  assertUserCanMakeCostIncurringRequest: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@/lib/api/chat-stream-helpers", () => ({
  assertFreeAgentGates: jest.fn(),
}));
jest.mock("@/lib/experiments/agent-steering.server", () => ({
  isAgentSteeringEnabled: () => mockFlag(),
}));
jest.mock("@/lib/analytics/agent-follow-up", () => ({
  captureAgentFollowUp: (...args: unknown[]) => mockCapture(...args),
}));
jest.mock("@/lib/api/agent-run-start", () => ({
  buildAgentRunDedupeKeyParts: (args: {
    userId: string;
    chatId: string;
    requestMessages: Array<{ id: string }>;
  }) => [
    "agent-run",
    args.userId,
    args.chatId,
    "send",
    args.requestMessages.at(-1)!.id,
  ],
  buildAgentRunIdempotencyKey: async (parts: string[]) => parts.join("|"),
  finalizeStartedAgentRun: (...args: unknown[]) => mockFinalize(...args),
  getAgentTriggerMachine: () => "small-2x",
  getAgentTriggerPriority: () => 5,
}));

import { tasks } from "@trigger.dev/sdk";
import {
  agentQueueDispatch,
  scheduleQueuedMessageDispatch,
} from "../agent-queue-dispatch";
import type { AgentLongPayload } from "../agent-long";

const mockMutation = jest.fn(),
  mockQuery = jest.fn(),
  mockGetChat = jest.fn(),
  mockEntitlement = jest.fn(),
  mockSaveMessage = jest.fn(),
  mockFinalize = jest.fn(),
  mockFlag = jest.fn(),
  mockCapture = jest.fn();

const finishedRun = {
  chatId: "chat",
  userId: "owner",
  subscription: "pro",
  organizationId: "org",
  convexUrl: "https://example.convex.cloud",
  agentPermissionMode: "full_access",
  sandboxPreference: "e2b",
  selectedModel: "auto",
  triggerRegion: "us-east-1",
  messages: [{ id: "old", role: "user", parts: [] }],
  baseTodos: [{ id: "t" }],
  isAutoContinue: true,
  approvalSessionId: undefined,
} as unknown as AgentLongPayload;

const dispatch = (run = finishedRun) =>
  (
    agentQueueDispatch as unknown as {
      run: (p: unknown) => Promise<{ outcome: string }>;
    }
  ).run({ run, completedRunId: "run-done", queuedId: "queued-1" });

const callsTo = (name: string) =>
  mockMutation.mock.calls.filter(([fn]) => fn === name);
const releaseCalls = () => callsTo("release");

describe("server dispatch of queued follow-ups", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CONVEX_SERVICE_ROLE_KEY = "service";
    mockFlag.mockResolvedValue(true);
    mockMutation.mockResolvedValue(null);
    mockQuery.mockResolvedValue({ id: "queued-1", text: "also check X" });
    mockEntitlement.mockResolvedValue({
      subscription: "pro",
      organizationId: "org",
    });
    mockGetChat.mockResolvedValue({
      user_id: "owner",
      project_id: "project",
    });
    mockSaveMessage.mockResolvedValue(undefined);
    mockFinalize.mockResolvedValue({ publicAccessToken: "token" });
    (tasks.trigger as jest.Mock).mockResolvedValue({ id: "run-next" });
  });

  it("starts the next turn as the queued message, with the route's dedupe key", async () => {
    await expect(dispatch()).resolves.toEqual({
      outcome: "started",
      runId: "run-next",
    });
    // Saved under the queued ID, which retires the queue row with the save.
    expect(mockSaveMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          {
            id: "queued-1",
            role: "user",
            parts: [{ type: "text", text: "also check X" }],
          },
        ],
      }),
    );
    const [, payload, options] = (tasks.trigger as jest.Mock).mock.calls[0];
    // A browser sending the same message resolves to this same run.
    expect(options.idempotencyKey).toBe("agent-run|owner|chat|send|queued-1");
    // A new user turn: no stale history, todos, continuation or session.
    expect(payload).toEqual(
      expect.objectContaining({
        messages: [],
        baseTodos: [],
        isAutoContinue: false,
        approvalSessionId: undefined,
        selectedModel: "auto",
        sandboxPreference: "e2b",
      }),
    );
    expect(mockFinalize).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-next",
        previousOwner: { runId: null, approvalSessionId: null },
      }),
    );
    expect(mockCapture).toHaveBeenCalledWith(
      "queue_dispatch_started",
      expect.objectContaining({ runId: "run-next", chatId: "chat" }),
    );
  });

  it("does nothing when the message was already sent or removed", async () => {
    mockQuery.mockResolvedValue(null);
    await expect(dispatch()).resolves.toEqual({ outcome: "not_queued" });
    expect(mockSaveMessage).not.toHaveBeenCalled();
    expect(tasks.trigger).not.toHaveBeenCalled();
  });

  it("hands the message back when the account or chat changed", async () => {
    mockEntitlement.mockResolvedValue({
      subscription: "free",
      organizationId: "org",
    });
    await expect(dispatch()).resolves.toEqual({
      outcome: "entitlement_changed",
    });
    mockEntitlement.mockResolvedValue({
      subscription: "pro",
      organizationId: "org",
    });
    // The user started another run in the meantime.
    mockGetChat.mockResolvedValue({
      user_id: "owner",
      active_trigger_run_id: "run-user",
    });
    await expect(dispatch()).resolves.toEqual({ outcome: "chat_unavailable" });
    expect(mockSaveMessage).not.toHaveBeenCalled();
    expect(
      mockCapture.mock.calls.map(([action, context]) => [
        action,
        context.skipReason,
      ]),
    ).toEqual([
      ["queue_dispatch_skipped", "entitlement_changed"],
      ["queue_dispatch_skipped", "chat_unavailable"],
    ]);
    expect(releaseCalls()).toHaveLength(2);
  });

  it("returns the message to the queue when no run could be started", async () => {
    mockSaveMessage.mockRejectedValueOnce(new Error("save failed"));
    await expect(dispatch()).rejects.toThrow("save failed");
    expect(releaseCalls()).toHaveLength(1);

    mockMutation.mockClear();
    // Every start attempt fails: no run exists, so the user can send it.
    (tasks.trigger as jest.Mock).mockRejectedValue(new Error("trigger down"));
    await expect(dispatch()).rejects.toThrow("trigger down");
    expect(tasks.trigger).toHaveBeenCalledTimes(3);
    expect(releaseCalls()).toHaveLength(1);
    expect(callsTo("complete")).toHaveLength(0);
  }, 15_000);

  it("retries a failed start with the same key, so it never starts twice", async () => {
    (tasks.trigger as jest.Mock)
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValue({ id: "run-next" });
    await expect(dispatch()).resolves.toEqual(
      expect.objectContaining({ outcome: "started" }),
    );
    const keys = (tasks.trigger as jest.Mock).mock.calls.map(
      ([, , options]) => options.idempotencyKey,
    );
    expect(new Set(keys).size).toBe(1);
    // The row leaves the queue only once the run is attached to the chat.
    expect(callsTo("complete")).toHaveLength(1);
    expect(mockFinalize.mock.invocationCallOrder[0]).toBeLessThan(
      mockMutation.mock.invocationCallOrder[
        mockMutation.mock.calls.findIndex(([fn]) => fn === "complete")
      ],
    );
  }, 15_000);

  it("never returns a message whose run started but could not be attached", async () => {
    mockFinalize.mockRejectedValueOnce(new Error("another run started"));
    await expect(dispatch()).rejects.toThrow("another run started");
    expect(releaseCalls()).toHaveLength(0);
    expect(callsTo("complete")).toHaveLength(1);
  });

  describe("after a run finishes", () => {
    it("claims and dispatches only for unattended, flagged, non-goal runs", async () => {
      mockMutation.mockResolvedValue({ id: "queued-1", text: "x", sentAt: 1 });
      await scheduleQueuedMessageDispatch(finishedRun, "run-done");
      expect(tasks.trigger).toHaveBeenCalledWith(
        "agent-queue-dispatch",
        expect.objectContaining({ queuedId: "queued-1" }),
        expect.objectContaining({ idempotencyKey: "queue-dispatch:run-done" }),
      );

      (tasks.trigger as jest.Mock).mockClear();
      mockMutation.mockClear();
      for (const run of [
        { ...finishedRun, goalGeneration: 3 },
        { ...finishedRun, agentPermissionMode: "ask_approval" },
      ] as AgentLongPayload[])
        await scheduleQueuedMessageDispatch(run, "run-done");
      mockFlag.mockResolvedValue(false);
      await scheduleQueuedMessageDispatch(finishedRun, "run-done");
      expect(mockMutation).not.toHaveBeenCalled();
      expect(tasks.trigger).not.toHaveBeenCalled();
    });

    it("releases the claim when the dispatcher cannot be started", async () => {
      mockMutation.mockResolvedValueOnce({ id: "queued-1", text: "x" });
      mockMutation.mockResolvedValue(null);
      (tasks.trigger as jest.Mock).mockRejectedValueOnce(new Error("down"));
      await expect(
        scheduleQueuedMessageDispatch(finishedRun, "run-done"),
      ).resolves.toBeUndefined();
      expect(mockMutation).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ id: "queued-1", completedRunId: "run-done" }),
      );
    });
  });
});
