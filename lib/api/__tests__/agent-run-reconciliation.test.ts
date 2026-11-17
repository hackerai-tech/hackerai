/**
 * @jest-environment node
 */
import { reconcileActiveAgentRuns } from "@/lib/api/agent-run-reconciliation";

type MockChat = {
  id: string;
  user_id: string;
  active_trigger_run_id?: string;
  active_agent_approval_session_id?: string;
  active_agent_approval_pending?: boolean;
};

type MockRun = { status: string; metadata?: unknown };

const mockChats = new Map<string, MockChat>();
const mockActiveChildren: unknown[] = [];
const mockRuns = new Map<string, MockRun>();
const mockRetrieve = jest.fn(async (runId: string): Promise<MockRun> => {
  const run = mockRuns.get(runId);
  if (!run) throw new MockApiError(404);
  return run;
});
const mockCancel = jest.fn(async (_runId: string) => undefined);
const mockSessionClose = jest.fn(
  async (_id: string, _options: { reason: string }) => undefined,
);
const mockSetActiveTriggerRun = jest.fn(
  async (args: {
    chatId: string;
    triggerRunId: string | null;
    approvalSessionId?: string | null;
    expectedRunId?: string;
    expectedApprovalSessionId?: string;
    clearApprovalPending?: boolean;
  }) => {
    // Mirrors the Convex compare-and-set fields this caller relies on.
    const chat = mockChats.get(args.chatId);
    if (!chat) return "not_found";
    if (
      chat.active_trigger_run_id !== args.expectedRunId ||
      (args.expectedApprovalSessionId !== undefined &&
        chat.active_agent_approval_session_id !==
          args.expectedApprovalSessionId)
    )
      return "stale";
    chat.active_trigger_run_id = args.triggerRunId ?? undefined;
    chat.active_agent_approval_session_id = args.approvalSessionId ?? undefined;
    if (args.clearApprovalPending) chat.active_agent_approval_pending = false;
    return "updated";
  },
);

jest.mock("@trigger.dev/sdk", () => {
  class ApiError extends Error {
    constructor(public status: number) {
      super(`HTTP ${status}`);
    }
  }
  return {
    ApiError,
    runs: {
      retrieve: (runId: string) => mockRetrieve(runId),
      cancel: (runId: string) => mockCancel(runId),
    },
    sessions: {
      close: (id: string, options: { reason: string }) =>
        mockSessionClose(id, options),
    },
  };
});
const { ApiError: MockApiError } = jest.requireMock<{
  ApiError: new (status: number) => Error;
}>("@trigger.dev/sdk");
jest.mock("@/lib/db/actions", () => ({
  getActiveTriggerRunsForUser: async ({ userId }: { userId: string }) => {
    const runs = [...mockChats.values()]
      .filter((chat) => chat.user_id === userId && chat.active_trigger_run_id)
      .map((chat) => ({
        chatId: chat.id,
        triggerRunId: chat.active_trigger_run_id!,
        ...(chat.active_agent_approval_session_id
          ? { approvalSessionId: chat.active_agent_approval_session_id }
          : {}),
      }));
    return { runs: runs.slice(0, 100), hasMore: runs.length > 100 };
  },
  getChatById: async ({ id }: { id: string }) => {
    const chat = mockChats.get(id);
    return chat ? { ...chat } : null;
  },
  setActiveTriggerRun: (args: Parameters<typeof mockSetActiveTriggerRun>[0]) =>
    mockSetActiveTriggerRun(args),
}));
jest.mock("@/lib/db/subagents", () => ({
  listActiveSubagentsForUser: async () => ({
    runs: [...mockActiveChildren],
    hasMore: false,
  }),
}));

const USER = "user-1";

const attach = (chatId: string, runId: string, sessionId?: string) => {
  mockChats.set(chatId, {
    id: chatId,
    user_id: USER,
    active_trigger_run_id: runId,
    ...(sessionId ? { active_agent_approval_session_id: sessionId } : {}),
    active_agent_approval_pending: true,
  });
};

const ownedRun = (chatId: string, status: string): MockRun => ({
  status,
  metadata: { chatId, userId: USER },
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "info").mockImplementation(() => undefined);
  mockChats.clear();
  mockRuns.clear();
  mockActiveChildren.length = 0;
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("reconcileActiveAgentRuns", () => {
  it("reports idle without provider reads when nothing is attached", async () => {
    await expect(reconcileActiveAgentRuns(USER)).resolves.toBe("idle");
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  it.each([
    "CANCELED",
    "COMPLETED",
    "FAILED",
    "SYSTEM_FAILURE",
    "EXPIRED",
    "TIMED_OUT",
  ])(
    "closes the exact Session and detaches an owned %s parent",
    async (status) => {
      attach("chat-1", "run-old", "session-old");
      mockRuns.set("run-old", ownedRun("chat-1", status));

      await expect(reconcileActiveAgentRuns(USER)).resolves.toBe("idle");

      expect(mockSessionClose).toHaveBeenCalledWith("session-old", {
        reason: "agent-run-terminal",
      });
      expect(mockSessionClose.mock.invocationCallOrder[0]).toBeLessThan(
        mockSetActiveTriggerRun.mock.invocationCallOrder[0],
      );
      expect(mockSetActiveTriggerRun).toHaveBeenCalledWith({
        chatId: "chat-1",
        triggerRunId: null,
        approvalSessionId: null,
        expectedRunId: "run-old",
        expectedApprovalSessionId: "session-old",
        clearApprovalPending: true,
      });
      expect(mockChats.get("chat-1")).toMatchObject({
        active_trigger_run_id: undefined,
        active_agent_approval_session_id: undefined,
        active_agent_approval_pending: false,
      });
      expect(mockCancel).not.toHaveBeenCalled();
    },
  );

  it("detaches a terminal parent that never had an approval Session", async () => {
    attach("chat-1", "run-old");
    mockRuns.set("run-old", ownedRun("chat-1", "COMPLETED"));

    await expect(reconcileActiveAgentRuns(USER)).resolves.toBe("idle");
    expect(mockSessionClose).not.toHaveBeenCalled();
    expect(mockChats.get("chat-1")?.active_trigger_run_id).toBeUndefined();
  });

  it.each([
    ["live and waiting for approval", ownedRun("chat-1", "WAITING")],
    ["executing", ownedRun("chat-1", "EXECUTING")],
    ["queued", ownedRun("chat-1", "QUEUED")],
    // Crash recovery replays its retained output from the status route.
    ["crashed with recoverable output", ownedRun("chat-1", "CRASHED")],
    [
      "owned by another user",
      { status: "CANCELED", metadata: { chatId: "chat-1", userId: "other" } },
    ],
    [
      "bound to another chat",
      { status: "CANCELED", metadata: { chatId: "chat-2", userId: USER } },
    ],
    ["missing ownership metadata", { status: "CANCELED" }],
  ])("keeps a parent that is %s", async (_label, run) => {
    attach("chat-1", "run-1", "session-1");
    mockRuns.set("run-1", run);

    await expect(reconcileActiveAgentRuns(USER)).resolves.toBe("active");

    expect(mockSessionClose).not.toHaveBeenCalled();
    expect(mockSetActiveTriggerRun).not.toHaveBeenCalled();
    expect(mockCancel).not.toHaveBeenCalled();
    expect(mockChats.get("chat-1")).toMatchObject({
      active_trigger_run_id: "run-1",
      active_agent_approval_session_id: "session-1",
    });
  });

  it.each([
    ["missing", () => Promise.reject(new MockApiError(404))],
    ["unavailable", () => Promise.reject(new MockApiError(503))],
  ])("keeps a parent whose Trigger status is %s", async (_label, response) => {
    attach("chat-1", "run-1", "session-1");
    mockRetrieve.mockImplementationOnce(response);

    await expect(reconcileActiveAgentRuns(USER)).resolves.toBe("active");
    expect(mockSessionClose).not.toHaveBeenCalled();
    expect(mockSetActiveTriggerRun).not.toHaveBeenCalled();
  });

  it("stops waiting for a stalled status read after a short deadline", async () => {
    jest.useFakeTimers();
    attach("chat-1", "run-1", "session-1");
    mockRetrieve.mockImplementationOnce(() => new Promise<MockRun>(() => {}));

    const outcome = reconcileActiveAgentRuns(USER);
    await jest.advanceTimersByTimeAsync(3_000);

    await expect(outcome).resolves.toBe("active");
    expect(mockSessionClose).not.toHaveBeenCalled();
    expect(mockSetActiveTriggerRun).not.toHaveBeenCalled();
  });

  it("keeps the reference when the Session cannot be closed", async () => {
    attach("chat-1", "run-old", "session-old");
    mockRuns.set("run-old", ownedRun("chat-1", "CANCELED"));
    mockSessionClose.mockRejectedValueOnce(new MockApiError(500));

    await expect(reconcileActiveAgentRuns(USER)).resolves.toBe("active");
    expect(mockSetActiveTriggerRun).not.toHaveBeenCalled();
    expect(mockChats.get("chat-1")?.active_trigger_run_id).toBe("run-old");
  });

  it("leaves a successor attached during the status read untouched", async () => {
    attach("chat-1", "run-old", "session-old");
    mockRetrieve.mockImplementationOnce(async () => {
      attach("chat-1", "run-new", "session-new");
      return ownedRun("chat-1", "CANCELED");
    });

    await expect(reconcileActiveAgentRuns(USER)).resolves.toBe("active");

    expect(mockSessionClose).not.toHaveBeenCalled();
    expect(mockSetActiveTriggerRun).not.toHaveBeenCalled();
    expect(mockChats.get("chat-1")).toMatchObject({
      active_trigger_run_id: "run-new",
      active_agent_approval_session_id: "session-new",
    });
  });

  it("does not detach a successor attached while the old Session closes", async () => {
    attach("chat-1", "run-old", "session-old");
    mockRuns.set("run-old", ownedRun("chat-1", "CANCELED"));
    mockSessionClose.mockImplementationOnce(async () => {
      attach("chat-1", "run-new", "session-new");
    });

    await expect(reconcileActiveAgentRuns(USER)).resolves.toBe("active");

    expect(mockSessionClose).toHaveBeenCalledTimes(1);
    expect(mockSessionClose).toHaveBeenCalledWith("session-old", {
      reason: "agent-run-terminal",
    });
    expect(mockChats.get("chat-1")).toMatchObject({
      active_trigger_run_id: "run-new",
      active_agent_approval_session_id: "session-new",
    });
  });

  it("clears terminal parents but stays active while another parent is live", async () => {
    attach("chat-1", "run-old", "session-old");
    attach("chat-2", "run-live", "session-live");
    mockRuns.set("run-old", ownedRun("chat-1", "CANCELED"));
    mockRuns.set("run-live", ownedRun("chat-2", "EXECUTING"));

    await expect(reconcileActiveAgentRuns(USER)).resolves.toBe("active");

    expect(mockChats.get("chat-1")?.active_trigger_run_id).toBeUndefined();
    expect(mockChats.get("chat-2")?.active_trigger_run_id).toBe("run-live");
    expect(mockSessionClose).toHaveBeenCalledTimes(1);
    expect(mockCancel).not.toHaveBeenCalled();
  });

  it("rereads children after clearing parents", async () => {
    attach("chat-1", "run-old", "session-old");
    mockRetrieve.mockImplementationOnce(async () => {
      mockActiveChildren.push({ subagent_id: "child-1" });
      return ownedRun("chat-1", "CANCELED");
    });

    await expect(reconcileActiveAgentRuns(USER)).resolves.toBe("active");
    expect(mockChats.get("chat-1")?.active_trigger_run_id).toBeUndefined();
  });

  it("spends one status read on each of at most five parents", async () => {
    for (let i = 0; i < 5; i++) {
      attach(`chat-${i}`, `run-${i}`, `session-${i}`);
      mockRuns.set(`run-${i}`, ownedRun(`chat-${i}`, "CANCELED"));
    }

    await expect(reconcileActiveAgentRuns(USER)).resolves.toBe("idle");
    expect(mockRetrieve).toHaveBeenCalledTimes(5);
  });

  it.each([
    [
      "more than five parents",
      () => {
        for (let i = 0; i < 6; i++) {
          attach(`chat-${i}`, `run-${i}`, `session-${i}`);
          mockRuns.set(`run-${i}`, ownedRun(`chat-${i}`, "CANCELED"));
        }
      },
    ],
    [
      "an active child",
      () => {
        attach("chat-1", "run-old", "session-old");
        mockRuns.set("run-old", ownedRun("chat-1", "CANCELED"));
        mockActiveChildren.push({ subagent_id: "child-1" });
      },
    ],
  ])("stays blocked without provider reads for %s", async (_label, setup) => {
    setup();

    await expect(reconcileActiveAgentRuns(USER)).resolves.toBe("active");
    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(mockSessionClose).not.toHaveBeenCalled();
    expect(mockSetActiveTriggerRun).not.toHaveBeenCalled();
  });
});
