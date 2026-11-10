import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockGetUserIDAndPro = jest.fn();
const mockGetChatById = jest.fn();
const mockSetActiveTriggerRun = jest.fn();
const mockCloseAgentApprovalSession = jest.fn();
const mockCancelAgentTriggerRun = jest.fn();
const mockLoggerWarn = jest.fn();
const mockPauseGoal = jest.fn();
const mockConvexSignal = jest.fn();
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: (signal?: AbortSignal) => {
    mockConvexSignal(signal);
    return { mutation: mockPauseGoal };
  },
}));
jest.mock("@/lib/goals/server", () => ({ goalServiceKey: () => "synthetic" }));

jest.mock("next/server", () => ({
  NextResponse: class MockNextResponse {
    status: number;
    private body: unknown;
    cookies = { set: jest.fn(), delete: jest.fn() };

    constructor(body?: unknown, init?: ResponseInit) {
      this.body = body;
      this.status = init?.status ?? 200;
    }

    static json(body: unknown, init?: ResponseInit) {
      return new MockNextResponse(body, init);
    }

    async json() {
      return this.body;
    }
  },
}));

jest.mock("@/lib/auth/get-user-id", () => ({
  getUserIDAndPro: mockGetUserIDAndPro,
}));

jest.mock("@/lib/db/actions", () => ({
  getChatById: mockGetChatById,
  setActiveTriggerRun: mockSetActiveTriggerRun,
}));

jest.mock("@/lib/api/agent-approval-session", () => ({
  cancelAgentTriggerRun: mockCancelAgentTriggerRun,
  closeAgentApprovalSession: mockCloseAgentApprovalSession,
}));

jest.mock("@/lib/api/agent-route-errors", () => ({
  handleAgentRouteError: jest.fn(() => {
    throw new Error("unexpected route error");
  }),
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: mockLoggerWarn },
}));

const request = (
  body: {
    chatId: string;
    expectedTriggerRunId?: string;
  } = { chatId: "chat-1" },
) =>
  ({
    json: jest.fn(async () => body),
    headers: {
      get: jest.fn((name: string) =>
        name === "x-vercel-id" ? "req_agent_cancel" : null,
      ),
    },
  }) as any;

describe("agent cancel route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCancelAgentTriggerRun.mockResolvedValue(true as never);
    mockGetUserIDAndPro.mockResolvedValue({ userId: "user-1" } as never);
    mockGetChatById.mockResolvedValue(null as never);
  });

  it("rejects cancellation when the persisted chat is missing", async () => {
    const { createAgentCancelPost } = await import("../agent-cancel-route");
    const response = await createAgentCancelPost({ endpoint: "/api/agent" })(
      request(),
    );

    expect(response.status).toBe(403);
    expect(mockCancelAgentTriggerRun).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "Rejected Agent cancellation request",
      expect.objectContaining({
        event: "agent_cancel_rejected",
        request_id: "req_agent_cancel",
        endpoint: "/api/agent",
        route: "/api/agent/cancel",
        reason: "chat_missing",
        status_code: 403,
        user_id: "user-1",
        chat_id: "chat-1",
      }),
    );
  });

  it("still cancels the worker and clears its lease if goal pausing fails", async () => {
    const { createAgentCancelPost } = await import("../agent-cancel-route");
    mockGetChatById.mockResolvedValue({
      id: "chat-1",
      user_id: "user-1",
      active_trigger_run_id: "run-1",
    } as never);
    mockPauseGoal.mockRejectedValueOnce(
      new Error("Storage unavailable") as never,
    );
    const response = await createAgentCancelPost({ endpoint: "/api/agent" })(
      request({ chatId: "chat-1", expectedTriggerRunId: "run-1" }),
    );
    expect(await response.json()).toEqual({ canceled: true, runId: "run-1" });
    expect(mockCancelAgentTriggerRun).toHaveBeenCalledWith("run-1");
    expect(mockSetActiveTriggerRun).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "chat-1",
        triggerRunId: null,
        expectedRunId: "run-1",
      }),
    );
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        event: "agent_cancel_goal_pause_failed",
      }),
    );
  });

  it("logs a distinct reason when a persisted chat belongs to another user", async () => {
    const { createAgentCancelPost } = await import("../agent-cancel-route");
    mockGetChatById.mockResolvedValue({ user_id: "user-2" } as never);

    const response = await createAgentCancelPost({ endpoint: "/api/agent" })(
      request(),
    );

    expect(response.status).toBe(403);
    expect(mockCancelAgentTriggerRun).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "Rejected Agent cancellation request",
      expect.objectContaining({
        event: "agent_cancel_rejected",
        reason: "chat_owner_mismatch",
        status_code: 403,
        user_id: "user-1",
        chat_id: "chat-1",
      }),
    );
  });

  it("cancels the expected active run for a persisted chat", async () => {
    const { createAgentCancelPost } = await import("../agent-cancel-route");
    mockGetChatById.mockResolvedValue({
      user_id: "user-1",
      active_trigger_run_id: "run-1",
      active_agent_approval_session_id: "approval-session-1",
    } as never);

    const response = await createAgentCancelPost({ endpoint: "/api/agent" })(
      request({
        chatId: "chat-1",
        expectedTriggerRunId: "run-1",
      }),
    );

    expect(response.status).toBe(200);
    expect(mockPauseGoal).toHaveBeenCalledWith(expect.anything(), {
      serviceKey: "synthetic",
      chatId: "chat-1",
      userId: "user-1",
      runId: "run-1",
    });
    expect(mockPauseGoal.mock.invocationCallOrder[0]).toBeLessThan(
      mockCancelAgentTriggerRun.mock.invocationCallOrder[0],
    );
    expect(mockCancelAgentTriggerRun).toHaveBeenCalledWith("run-1");
    expect(mockSetActiveTriggerRun).toHaveBeenCalledWith({
      chatId: "chat-1",
      triggerRunId: null,
      approvalSessionId: null,
      expectedRunId: "run-1",
      expectedApprovalSessionId: "approval-session-1",
      clearApprovalPending: true,
    });
  });

  it("does not let a stale cancellation stop a replacement run", async () => {
    const { createAgentCancelPost } = await import("../agent-cancel-route");
    mockGetChatById.mockResolvedValue({
      user_id: "user-1",
      active_trigger_run_id: "run-2",
    } as never);

    const response = await createAgentCancelPost({ endpoint: "/api/agent" })(
      request({
        chatId: "chat-1",
        expectedTriggerRunId: "run-1",
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      canceled: false,
      reason: "stale_run",
      activeTriggerRunId: "run-2",
    });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "Rejected Agent cancellation request",
      expect.objectContaining({
        event: "agent_cancel_rejected",
        request_id: "req_agent_cancel",
        endpoint: "/api/agent",
        route: "/api/agent/cancel",
        reason: "stale_run",
        status_code: 409,
        user_id: "user-1",
        chat_id: "chat-1",
      }),
    );
    expect(mockPauseGoal).not.toHaveBeenCalled();
    expect(mockCloseAgentApprovalSession).not.toHaveBeenCalled();
    expect(mockCancelAgentTriggerRun).not.toHaveBeenCalled();
    expect(mockSetActiveTriggerRun).not.toHaveBeenCalled();
  });

  it("still cancels the captured run when approval cleanup fails", async () => {
    const { createAgentCancelPost } = await import("../agent-cancel-route");
    const { handleAgentRouteError } = await import("../agent-route-errors");
    mockGetChatById.mockResolvedValue({
      id: "chat-1",
      user_id: "user-1",
      active_trigger_run_id: "run-1",
      active_agent_approval_session_id: "approval-1",
    } as never);
    mockCloseAgentApprovalSession.mockRejectedValueOnce(
      new Error("Approval service unavailable") as never,
    );

    await expect(
      createAgentCancelPost({ endpoint: "/api/agent" })(
        request({ chatId: "chat-1", expectedTriggerRunId: "run-1" }),
      ),
    ).rejects.toThrow("unexpected route error");

    expect(mockCancelAgentTriggerRun).toHaveBeenCalledWith("run-1");
    expect(mockSetActiveTriggerRun).not.toHaveBeenCalled();
    expect(handleAgentRouteError).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ stage: "close_approval_session" }),
      }),
    );
  });

  it("recovers a failed session close after worker exit using the retained association", async () => {
    const { createAgentCancelPost } = await import("../agent-cancel-route");
    const { clearFinishedAgentRun } = await import("../agent-run-cleanup");
    const owned = {
      user_id: "user-1",
      active_trigger_run_id: "run-1",
      active_agent_approval_session_id: "approval-1",
    };
    mockGetChatById.mockResolvedValue(owned as never);
    mockCloseAgentApprovalSession.mockRejectedValueOnce(
      new Error("Unavailable") as never,
    );
    const post = createAgentCancelPost({ endpoint: "/api/agent" });
    await expect(
      post(request({ chatId: "chat-1", expectedTriggerRunId: "run-1" })),
    ).rejects.toThrow("unexpected route error");
    // The worker's independent close also failed. Its finalization must keep
    // the association so a client retry can still reach the old session.
    await clearFinishedAgentRun({
      chatId: "chat-1",
      triggerRunId: "run-1",
      approvalSessionId: "approval-1",
      approvalSessionClosed: false,
    });
    expect(mockSetActiveTriggerRun).not.toHaveBeenCalled();
    const response = await post(
      request({ chatId: "chat-1", expectedTriggerRunId: "run-1" }),
    );
    expect(await response.json()).toEqual({ canceled: true, runId: "run-1" });
    expect(mockCloseAgentApprovalSession.mock.calls).toEqual([
      ["approval-1", "agent-run-canceled"],
      ["approval-1", "agent-run-canceled"],
    ]);
    expect(mockSetActiveTriggerRun).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRunId: "run-1",
        expectedApprovalSessionId: "approval-1",
        triggerRunId: null,
        approvalSessionId: null,
      }),
    );
  });

  it("reports an explicit null when a stale cancellation has no active run", async () => {
    const { createAgentCancelPost } = await import("../agent-cancel-route");
    mockGetChatById.mockResolvedValue({
      user_id: "user-1",
      active_trigger_run_id: null,
    } as never);

    const response = await createAgentCancelPost({ endpoint: "/api/agent" })(
      request({
        chatId: "chat-1",
        expectedTriggerRunId: "run-1",
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      canceled: false,
      reason: "stale_run",
      activeTriggerRunId: null,
    });
    expect(mockCancelAgentTriggerRun).not.toHaveBeenCalled();
  });
});

describe("cancellation timeout diagnostics", () => {
  const ownedChat = {
    id: "chat-1",
    user_id: "user-1",
    active_trigger_run_id: "run-1",
    active_agent_approval_session_id: "approval-1",
  };
  const deferred = () => {
    let resolve!: (value?: any) => void;
    const promise = new Promise<any>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const warnings = () =>
    jest
      .mocked(console.warn)
      .mock.calls.map(([line]) => JSON.parse(line as string));

  beforeEach(() => {
    jest.resetAllMocks();
    mockCancelAgentTriggerRun.mockResolvedValue(true as never);
    jest.useFakeTimers();
    jest.spyOn(console, "warn").mockImplementation(() => {});
    mockGetUserIDAndPro.mockResolvedValue({ userId: "user-1" } as never);
    mockGetChatById.mockResolvedValue(ownedChat as never);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("continues Stop after five seconds even if goal storage ignores abort", async () => {
    const { createAgentCancelPost } = await import("../agent-cancel-route");
    const pause = deferred();
    mockPauseGoal.mockReturnValueOnce(pause.promise);
    const response = createAgentCancelPost({ endpoint: "/api/agent" })(
      request({ chatId: "chat-1", expectedTriggerRunId: "run-1" }),
    );
    try {
      await jest.advanceTimersByTimeAsync(4_999);
      expect(mockCancelAgentTriggerRun).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(mockCancelAgentTriggerRun).toHaveBeenCalledWith("run-1");
      expect(await (await response).json()).toEqual({
        canceled: true,
        runId: "run-1",
      });
      expect(mockConvexSignal.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
      expect((mockConvexSignal.mock.calls[0][0] as AbortSignal).aborted).toBe(
        true,
      );
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          event: "agent_cancel_goal_pause_unconfirmed",
          pause_acknowledgement: "unconfirmed",
          failure_reason: "deadline_exceeded",
        }),
      );
      expect(mockSetActiveTriggerRun).toHaveBeenCalledWith(
        expect.objectContaining({ expectedRunId: "run-1" }),
      );
    } finally {
      pause.resolve();
      await response;
    }
    expect(mockPauseGoal).toHaveBeenCalledTimes(1);
    expect(mockCancelAgentTriggerRun).toHaveBeenCalledTimes(1);
    expect(mockSetActiveTriggerRun).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("clears the goal-pause deadline after prompt storage success", async () => {
    const { createAgentCancelPost } = await import("../agent-cancel-route");
    const response = await createAgentCancelPost({ endpoint: "/api/agent" })(
      request({ chatId: "chat-1", expectedTriggerRunId: "run-1" }),
    );
    expect(response.status).toBe(200);
    await jest.advanceTimersByTimeAsync(10_000);
    expect((mockConvexSignal.mock.calls[0][0] as AbortSignal).aborted).toBe(
      false,
    );
    expect(mockLoggerWarn).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it("delivers Stop while approval cleanup is pending without acknowledging completion", async () => {
    const { createAgentCancelPost } = await import("../agent-cancel-route");
    const approval = deferred();
    mockCloseAgentApprovalSession.mockReturnValueOnce(approval.promise);
    let completed = false;
    const response = createAgentCancelPost({ endpoint: "/api/agent" })(
      request({ chatId: "chat-1", expectedTriggerRunId: "run-1" }),
    ).then((value) => {
      completed = true;
      return value;
    });
    try {
      await jest.advanceTimersByTimeAsync(20_000);
      expect(mockCancelAgentTriggerRun).toHaveBeenCalledWith("run-1");
      expect(completed).toBe(false);
      expect(mockSetActiveTriggerRun).not.toHaveBeenCalled();
      expect(warnings().map((log) => log.stage)).toEqual([
        "close_approval_session",
        "close_approval_session",
      ]);
    } finally {
      approval.resolve();
      await response;
    }
    expect(await (await response).json()).toEqual({
      canceled: true,
      runId: "run-1",
    });
    expect(mockSetActiveTriggerRun).toHaveBeenCalledWith({
      chatId: "chat-1",
      triggerRunId: null,
      approvalSessionId: null,
      expectedRunId: "run-1",
      expectedApprovalSessionId: "approval-1",
      clearApprovalPending: true,
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  it("observes both cleanup failures and preserves ownership for retry", async () => {
    const { createAgentCancelPost } = await import("../agent-cancel-route");
    const { handleAgentRouteError } = await import("../agent-route-errors");
    const cancelFailure = new Error("Cancel unavailable");
    mockCancelAgentTriggerRun.mockRejectedValueOnce(cancelFailure as never);
    mockCloseAgentApprovalSession.mockRejectedValueOnce(
      new Error("Close unavailable") as never,
    );
    await createAgentCancelPost({ endpoint: "/api/agent" })(request());
    expect(handleAgentRouteError).toHaveBeenCalledWith(
      expect.objectContaining({
        error: cancelFailure,
        context: expect.objectContaining({ stage: "cancel_trigger_run" }),
      }),
    );
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        event: "agent_cancel_approval_cleanup_failed",
        trigger_run_id: "run-1",
        approval_session_id: "approval-1",
      }),
    );
    expect(mockSetActiveTriggerRun).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([
    "read_request",
    "authenticate",
    "get_chat",
    "close_approval_session",
    "cancel_trigger_run",
    "clear_active_run",
    "clear_without_run",
  ])("captures the pending %s without replaying work", async (stage) => {
    const { createAgentCancelPost } = await import("../agent-cancel-route");
    const pending = deferred();
    const req = request();
    const values: Record<string, unknown> = {
      read_request: { chatId: "chat-1", privateContent: "private prompt" },
      authenticate: { userId: "user-1" },
      get_chat: ownedChat,
    };
    if (stage === "read_request") req.json = () => pending.promise;
    if (stage === "authenticate")
      mockGetUserIDAndPro.mockReturnValueOnce(pending.promise);
    if (stage === "get_chat")
      mockGetChatById.mockReturnValueOnce(pending.promise);
    if (stage === "pause_goal")
      mockPauseGoal.mockReturnValueOnce(pending.promise);
    if (stage === "close_approval_session")
      mockCloseAgentApprovalSession.mockReturnValueOnce(pending.promise);
    if (stage === "cancel_trigger_run")
      mockCancelAgentTriggerRun.mockReturnValueOnce(pending.promise);
    if (stage === "clear_active_run" || stage === "clear_without_run")
      mockSetActiveTriggerRun.mockReturnValueOnce(pending.promise);
    if (stage === "clear_without_run")
      mockGetChatById.mockResolvedValueOnce({
        ...ownedChat,
        active_trigger_run_id: null,
      } as never);
    const response = createAgentCancelPost({ endpoint: "/api/agent" })(req);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toMatchObject({
      event: "agent_cancel_slow_request",
      request_id: "req_agent_cancel",
      stage: stage === "clear_without_run" ? "clear_active_run" : stage,
      elapsed_ms: 10_000,
    });
    const authorized = [
      "pause_goal",
      "close_approval_session",
      "cancel_trigger_run",
      "clear_active_run",
      "clear_without_run",
    ].includes(stage);
    expect(warnings()[0].chat_id).toBe(authorized ? "chat-1" : undefined);
    expect(warnings()[0].trigger_run_id).toBe(
      authorized && stage !== "clear_without_run" ? "run-1" : undefined,
    );
    expect(warnings()[0].approval_session_id).toBe(
      authorized ? "approval-1" : undefined,
    );
    expect(warnings()[0].user_id).toBe(
      ["read_request", "authenticate"].includes(stage) ? undefined : "user-1",
    );
    expect(JSON.stringify(warnings())).not.toContain("private prompt");
    await jest.advanceTimersByTimeAsync(50_000);
    expect(warnings()).toHaveLength(2);
    pending.resolve(values[stage]);
    expect((await response).status).toBe(200);
    expect(jest.getTimerCount()).toBe(0);
    expect(mockCloseAgentApprovalSession).toHaveBeenCalledTimes(1);
    expect(mockCancelAgentTriggerRun).toHaveBeenCalledTimes(
      stage === "clear_without_run" ? 0 : 1,
    );
    expect(mockSetActiveTriggerRun).toHaveBeenCalledTimes(1);
    if (stage === "clear_without_run")
      expect(mockSetActiveTriggerRun).toHaveBeenCalledWith({
        chatId: "chat-1",
        triggerRunId: null,
        approvalSessionId: null,
        expectedApprovalSessionId: "approval-1",
        clearApprovalPending: true,
      });
  });

  it.each(["/api/agent", "/api/agent-long"] as const)(
    "shares the two-warning budget across stages on %s",
    async (endpoint) => {
      const { createAgentCancelPost } = await import("../agent-cancel-route");
      const auth = deferred();
      const cancellation = deferred();
      mockGetUserIDAndPro.mockReturnValueOnce(auth.promise);
      mockCancelAgentTriggerRun.mockReturnValueOnce(cancellation.promise);
      const response = createAgentCancelPost({ endpoint })(request());
      await jest.advanceTimersByTimeAsync(10_000);
      expect(mockCloseAgentApprovalSession).not.toHaveBeenCalled();
      auth.resolve({ userId: "user-1" });
      await jest.advanceTimersByTimeAsync(10_000);
      expect(warnings().map((log) => log.stage)).toEqual([
        "authenticate",
        "cancel_trigger_run",
      ]);
      expect(warnings().map((log) => log.endpoint)).toEqual([
        endpoint,
        endpoint,
      ]);
      expect(mockCloseAgentApprovalSession).toHaveBeenCalledTimes(1);
      expect(mockSetActiveTriggerRun).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(60_000);
      expect(warnings()).toHaveLength(2);
      cancellation.resolve();
      expect(await (await response).json()).toEqual({
        canceled: true,
        runId: "run-1",
      });
      expect(mockSetActiveTriggerRun).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it("clears the second warning when cancellation completes after the first", async () => {
    const { createAgentCancelPost } = await import("../agent-cancel-route");
    const pending = deferred();
    mockCancelAgentTriggerRun.mockReturnValueOnce(pending.promise);
    const response = createAgentCancelPost({ endpoint: "/api/agent" })(
      request(),
    );
    await jest.advanceTimersByTimeAsync(10_000);
    pending.resolve();
    await response;
    await jest.advanceTimersByTimeAsync(60_000);
    expect(warnings()).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([null, "private request content", "x".repeat(129)])(
    "omits an absent or unsafe platform request identifier (%p)",
    async (header) => {
      const { createAgentCancelPost } = await import("../agent-cancel-route");
      const pending = deferred();
      const req = request();
      req.headers.get = () => header;
      mockGetUserIDAndPro.mockReturnValueOnce(pending.promise);
      const response = createAgentCancelPost({ endpoint: "/api/agent" })(req);
      await jest.advanceTimersByTimeAsync(10_000);
      expect(warnings()[0].request_id).toBe("unknown");
      expect(warnings()[0].user_id).toBeUndefined();
      if (header) expect(JSON.stringify(warnings())).not.toContain(header);
      pending.resolve({ userId: "user-1" });
      await response;
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it.each([
    "invalid_json",
    "missing_id",
    "invalid_expected_run",
    "missing_chat",
    "forbidden",
    "stale_run",
    "no_active_run",
    "auth_error",
    "cancel_error",
  ])("clears timers after %s", async (outcome) => {
    const { createAgentCancelPost } = await import("../agent-cancel-route");
    const { handleAgentRouteError } = await import("../agent-route-errors");
    jest.mocked(handleAgentRouteError).mockImplementation(() => {
      throw new Error("route error");
    });
    const req = request();
    if (outcome === "invalid_json")
      req.json = async () => {
        throw new Error("bad JSON");
      };
    if (outcome === "missing_id") req.json = async () => ({});
    if (outcome === "invalid_expected_run")
      req.json = async () => ({ chatId: "chat-1", expectedTriggerRunId: 3 });
    if (outcome === "missing_chat")
      mockGetChatById.mockResolvedValueOnce(null as never);
    if (outcome === "forbidden")
      mockGetChatById.mockResolvedValueOnce({
        ...ownedChat,
        user_id: "other-user",
      } as never);
    if (outcome === "stale_run")
      req.json = async () => ({
        chatId: "chat-1",
        expectedTriggerRunId: "old-run",
      });
    if (outcome === "no_active_run")
      mockGetChatById.mockResolvedValueOnce({
        ...ownedChat,
        active_trigger_run_id: null,
        active_agent_approval_session_id: null,
      } as never);
    const failure = new Error("dependency failed");
    if (outcome === "auth_error")
      mockGetUserIDAndPro.mockRejectedValueOnce(failure as never);
    if (outcome === "cancel_error")
      mockCancelAgentTriggerRun.mockRejectedValueOnce(failure as never);
    const response = createAgentCancelPost({ endpoint: "/api/agent" })(req);
    if (outcome.endsWith("_error")) {
      await expect(response).rejects.toThrow("route error");
      expect(handleAgentRouteError).toHaveBeenCalledWith(
        expect.objectContaining({
          error: failure,
          context: expect.objectContaining({
            stage:
              outcome === "auth_error" ? "authenticate" : "cancel_trigger_run",
            chatId: outcome === "auth_error" ? undefined : "chat-1",
          }),
        }),
      );
    } else {
      const expected = [
        "invalid_json",
        "missing_id",
        "invalid_expected_run",
      ].includes(outcome)
        ? 400
        : outcome === "stale_run"
          ? 409
          : outcome === "no_active_run"
            ? 200
            : 403;
      expect((await response).status).toBe(expected);
    }
    expect(mockSetActiveTriggerRun).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(warnings()).toHaveLength(0);
  });
});
