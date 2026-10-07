import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

const mockGetUserIDAndPro = jest.fn();
const mockGetChatById = jest.fn();
const mockSetActiveTriggerRun = jest.fn();
const mockRunsRetrieve = jest.fn();
const mockCloseAgentApprovalSession = jest.fn();

jest.mock("next/server", () => ({
  NextResponse: class MockNextResponse {
    status: number;
    private body: unknown;

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

jest.mock("@trigger.dev/sdk", () => ({
  ApiError: class MockApiError extends Error {
    status?: number;
  },
  runs: { retrieve: mockRunsRetrieve },
}));

jest.mock("@/lib/auth/get-user-id", () => ({
  getUserIDAndPro: mockGetUserIDAndPro,
}));

jest.mock("@/lib/db/actions", () => ({
  getChatById: mockGetChatById,
  setActiveTriggerRun: mockSetActiveTriggerRun,
}));

jest.mock("@/lib/api/agent-approval-session", () => ({
  closeAgentApprovalSession: mockCloseAgentApprovalSession,
}));

jest.mock("@/lib/api/agent-route-errors", () => ({
  handleAgentRouteError: jest.fn(() => {
    throw new Error("unexpected route error");
  }),
}));

const requestFor = (chatId: string, runId: string) =>
  ({
    headers: { get: () => null },
    json: async () => ({ chatId, runId }),
  }) as any;

describe("agent status route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserIDAndPro.mockResolvedValue({ userId: "user-1" } as never);
  });

  it("reports a nonterminal run without touching persisted lifecycle state", async () => {
    const { createAgentStatusPost } = await import("../agent-status-route");
    mockGetChatById.mockResolvedValue({
      id: "chat-1",
      user_id: "user-1",
      active_trigger_run_id: "run-1",
    } as never);
    mockRunsRetrieve.mockResolvedValue({
      status: "EXECUTING",
      metadata: { chatId: "chat-1", userId: "user-1" },
    } as never);

    const response = await createAgentStatusPost({ endpoint: "/api/agent" })(
      requestFor("chat-1", "run-1"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "EXECUTING",
      terminal: false,
    });
    expect(mockGetChatById).toHaveBeenCalledWith({ id: "chat-1" });
    expect(mockSetActiveTriggerRun).not.toHaveBeenCalled();
  });

  it("treats a persisted run detached during cleanup as UI-terminal", async () => {
    const { createAgentStatusPost } = await import("../agent-status-route");
    mockGetChatById.mockResolvedValue({
      id: "chat-1",
      user_id: "user-1",
      active_trigger_run_id: null,
    } as never);

    const response = await createAgentStatusPost({ endpoint: "/api/agent" })(
      requestFor("chat-1", "run-1"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "DETACHED",
      terminal: true,
    });
    expect(mockRunsRetrieve).not.toHaveBeenCalled();
    expect(mockSetActiveTriggerRun).not.toHaveBeenCalled();
  });

  it("reports terminal status and compare-clears the matching active run", async () => {
    const { createAgentStatusPost } = await import("../agent-status-route");
    mockRunsRetrieve.mockResolvedValue({
      status: "COMPLETED",
      metadata: { chatId: "chat-1", userId: "user-1" },
    } as never);
    mockGetChatById.mockResolvedValue({
      id: "chat-1",
      user_id: "user-1",
      active_trigger_run_id: "run-1",
      active_agent_approval_session_id: "approval-session-1",
    } as never);

    const response = await createAgentStatusPost({ endpoint: "/api/agent" })(
      requestFor("chat-1", "run-1"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "COMPLETED",
      terminal: true,
    });
    expect(mockCloseAgentApprovalSession).toHaveBeenCalledWith(
      "approval-session-1",
      "agent-run-terminal",
    );
    expect(mockSetActiveTriggerRun).toHaveBeenCalledWith({
      chatId: "chat-1",
      triggerRunId: null,
      approvalSessionId: null,
      expectedRunId: "run-1",
      clearApprovalPending: true,
    });
  });

  it("does not reveal status for a chat owned by another user", async () => {
    const { createAgentStatusPost } = await import("../agent-status-route");
    mockGetChatById.mockResolvedValue({
      id: "chat-1",
      user_id: "user-2",
      active_trigger_run_id: "run-1",
    } as never);

    const response = await createAgentStatusPost({ endpoint: "/api/agent" })(
      requestFor("chat-1", "run-1"),
    );

    expect(response.status).toBe(403);
    expect(mockRunsRetrieve).not.toHaveBeenCalled();
  });
});

describe("agent status timeout diagnostics", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    mockGetUserIDAndPro.mockResolvedValue({ userId: "user-1" } as never);
    mockGetChatById.mockResolvedValue({
      id: "chat-1",
      user_id: "user-1",
      active_trigger_run_id: "run-1",
    } as never);
    mockRunsRetrieve.mockResolvedValue({
      status: "COMPLETED",
      metadata: { chatId: "chat-1", userId: "user-1" },
    } as never);
  });

  afterEach(() => {
    const timers = jest.getTimerCount();
    jest.useRealTimers();
    jest.restoreAllMocks();
    expect(timers).toBe(0);
  });

  it.each([
    "read_request",
    "authenticate",
    "get_chat",
    "retrieve_trigger_run",
    "clear_terminal_trigger_run",
    "clear_missing_trigger_run",
  ])(
    "identifies a blocked %s without exceeding two warnings",
    async (stage) => {
      const { createAgentStatusPost } = await import("../agent-status-route");
      let finish!: (value: any) => void;
      const pending = new Promise((resolve) => {
        finish = resolve;
      });
      const request = requestFor("chat-1", "run-1");
      // Untrusted headers and unrelated body content must never enter telemetry.
      request.headers.get = () => "secret-request-content";
      const body = {
        chatId: "chat-1",
        runId: "run-1",
        prompt: "private prompt",
      };
      request.json = async () => body;
      const values: Record<string, unknown> = {
        read_request: body,
        authenticate: { userId: "user-1" },
        get_chat: {
          id: "chat-1",
          user_id: "user-1",
          active_trigger_run_id: "run-1",
        },
        retrieve_trigger_run: {
          status: "COMPLETED",
          metadata: { chatId: "chat-1", userId: "user-1" },
        },
        clear_terminal_trigger_run: undefined,
      };
      if (stage === "read_request") request.json = () => pending;
      if (stage === "authenticate")
        mockGetUserIDAndPro.mockReturnValueOnce(pending);
      if (stage === "get_chat") mockGetChatById.mockReturnValueOnce(pending);
      if (stage === "retrieve_trigger_run")
        mockRunsRetrieve.mockReturnValueOnce(pending);
      if (stage === "clear_missing_trigger_run") {
        const { ApiError } = await import("@trigger.dev/sdk");
        const missing = Object.assign(new Error("missing"), { status: 404 });
        Object.setPrototypeOf(missing, ApiError.prototype);
        mockRunsRetrieve.mockRejectedValueOnce(missing as never);
      }
      if (
        stage === "clear_terminal_trigger_run" ||
        stage === "clear_missing_trigger_run"
      )
        mockCloseAgentApprovalSession.mockReturnValueOnce(pending);

      const response = createAgentStatusPost({ endpoint: "/api/agent" })(
        request,
      );
      await jest.advanceTimersByTimeAsync(10_000);
      expect(console.warn).toHaveBeenCalledTimes(1);
      const first = JSON.parse(
        jest.mocked(console.warn).mock.calls[0][0] as string,
      );
      expect(first).toMatchObject({
        event: "agent_status_slow_request",
        stage,
        elapsed_ms: 10_000,
      });
      if (
        stage === "retrieve_trigger_run" ||
        stage === "clear_terminal_trigger_run" ||
        stage === "clear_missing_trigger_run"
      ) {
        expect(first).toMatchObject({
          chat_id: "chat-1",
          trigger_run_id: "run-1",
        });
      } else {
        expect(first.chat_id).toBeUndefined();
        expect(first.trigger_run_id).toBeUndefined();
      }
      expect(JSON.stringify(first)).not.toMatch(
        /secret-request-content|private prompt/,
      );
      await jest.advanceTimersByTimeAsync(50_000);
      expect(console.warn).toHaveBeenCalledTimes(2);
      finish(values[stage]);
      expect((await response).status).toBe(
        stage === "clear_missing_trigger_run" ? 404 : 200,
      );
    },
  );

  it("cancels the second warning when a slow request completes", async () => {
    const { createAgentStatusPost } = await import("../agent-status-route");
    let finish!: (value: any) => void;
    mockRunsRetrieve.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const response = createAgentStatusPost({ endpoint: "/api/agent" })(
      requestFor("chat-1", "run-1"),
    );
    await jest.advanceTimersByTimeAsync(10_000);
    expect(console.warn).toHaveBeenCalledTimes(1);
    finish({
      status: "EXECUTING",
      metadata: { chatId: "chat-1", userId: "user-1" },
    });
    await response;
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it.each(["/api/agent", "/api/agent-long"] as const)(
    "takes a fresh stage snapshot and clears timers after %s finishes",
    async (endpoint) => {
      const { createAgentStatusPost } = await import("../agent-status-route");
      let authenticate!: (value: any) => void;
      let retrieve!: (value: any) => void;
      mockGetUserIDAndPro.mockReturnValueOnce(
        new Promise((resolve) => {
          authenticate = resolve;
        }),
      );
      mockRunsRetrieve.mockReturnValueOnce(
        new Promise((resolve) => {
          retrieve = resolve;
        }),
      );
      const response = createAgentStatusPost({ endpoint })(
        requestFor("chat-1", "run-1"),
      );
      await jest.advanceTimersByTimeAsync(10_000);
      authenticate({ userId: "user-1" });
      await jest.advanceTimersByTimeAsync(10_000);
      const logs = jest
        .mocked(console.warn)
        .mock.calls.map(([line]) => JSON.parse(line as string));
      expect(logs.map((log) => log.stage)).toEqual([
        "authenticate",
        "retrieve_trigger_run",
      ]);
      expect(logs.map((log) => log.endpoint)).toEqual([endpoint, endpoint]);
      retrieve({
        status: "EXECUTING",
        metadata: { chatId: "chat-1", userId: "user-1" },
      });
      expect((await response).status).toBe(200);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(console.warn).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["invalid_json", "missing_id", "forbidden", "error"])(
    "does not retain timers after an early %s exit",
    async (outcome) => {
      const { createAgentStatusPost } = await import("../agent-status-route");
      const request = requestFor("chat-1", "run-1");
      if (outcome === "invalid_json")
        request.json = async () => {
          throw new Error("invalid json");
        };
      if (outcome === "missing_id") request.json = async () => ({});
      if (outcome === "forbidden")
        mockGetChatById.mockResolvedValueOnce({
          user_id: "another-user",
        } as never);
      if (outcome === "error")
        mockRunsRetrieve.mockRejectedValueOnce(
          new Error("provider unavailable") as never,
        );
      const response = createAgentStatusPost({ endpoint: "/api/agent" })(
        request,
      );
      if (outcome === "error") {
        await expect(response).rejects.toThrow("unexpected route error");
        const { handleAgentRouteError } = await import("../agent-route-errors");
        expect(handleAgentRouteError).toHaveBeenCalledWith(
          expect.objectContaining({
            context: expect.objectContaining({ stage: "retrieve_trigger_run" }),
          }),
        );
      } else
        expect((await response).status).toBe(
          outcome === "forbidden" ? 403 : 400,
        );
      expect(jest.getTimerCount()).toBe(0);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(console.warn).not.toHaveBeenCalled();
    },
  );
});
