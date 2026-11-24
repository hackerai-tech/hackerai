import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import type { AuthkitOptions } from "@workos-inc/authkit-nextjs";
import { channel } from "node:diagnostics_channel";
import { AgentCrashRecoveryReplayLimitError } from "../agent-crash-recovery-error";
import {
  serviceTransportObserverKey,
  serviceTransportRuntime,
} from "../../db/service-transport-observation";
import { registerServiceTransportObserver } from "../../db/service-transport-observation.node";

const mockGetUserIDAndPro = jest.fn();
const mockGetChatById = jest.fn();
const mockSetActiveTriggerRun = jest.fn();
const mockRunsRetrieve = jest.fn();
const mockRecover = jest.fn();
const mockCloseAgentApprovalSession = jest.fn();
const mockAuthkit = jest.fn();

jest.mock("@workos-inc/authkit-nextjs", () => ({
  authkit: (...args: unknown[]) => mockAuthkit(...args),
}));

jest.mock("@/lib/api/agent-crash-recovery", () => ({
  recoverCrashedAgentRun: (...args: unknown[]) => mockRecover(...args),
}));

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

jest.mock("@/lib/api/agent-route-errors", () => {
  // Typed errors keep the real handler, its HTTP response and 503 receipt;
  // any other error reaching the handler is unexpected in these cases.
  const web = jest.requireActual<{ Response: typeof Response }>(
    "next/dist/compiled/@edge-runtime/primitives/fetch",
  );
  globalThis.Response ??= web.Response;
  const actual = jest.requireActual<typeof import("../agent-route-errors")>(
    "../agent-route-errors",
  );
  const { ChatSDKError } =
    jest.requireActual<typeof import("../../errors")>("../../errors");
  return {
    handleAgentRouteError: jest.fn(
      (input: Parameters<typeof actual.handleAgentRouteError>[0]) => {
        if (input.error instanceof ChatSDKError)
          return actual.handleAgentRouteError(input);
        throw new Error("unexpected route error");
      },
    ),
  };
});

const requestFor = (chatId: string, runId: string) =>
  ({
    headers: { get: () => null },
    json: async () => ({ chatId, runId }),
  }) as any;

// Places the owned Trigger read just before a request-level warning threshold:
// the read itself is bounded, so only an earlier slow stage can reach it.
const authenticateAfter = (delayMs: number) =>
  mockGetUserIDAndPro.mockImplementationOnce(
    () =>
      new Promise((resolve) =>
        setTimeout(() => resolve({ userId: "user-1" }), delayMs),
      ),
  );

const warningsFor = (event: string) =>
  jest
    .mocked(console.warn)
    .mock.calls.map(([line]) => JSON.parse(line as string))
    .filter((line) => line.event === event);

describe("agent status route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRecover.mockResolvedValue("recovered" as never);
    mockSetActiveTriggerRun.mockResolvedValue("updated" as never);
    mockGetUserIDAndPro.mockResolvedValue({ userId: "user-1" } as never);
  });

  it.each([{}, { chatId: "chat-1" }, { userId: "user-1" }])(
    "keeps an owned approval run polling with incomplete ownership metadata: %j",
    async (metadata) => {
      const { createAgentStatusPost } = await import("../agent-status-route");
      mockGetChatById.mockResolvedValue({
        id: "chat-1",
        user_id: "user-1",
        active_trigger_run_id: "run-1",
        active_agent_approval_session_id: "approval-1",
      } as never);
      mockRunsRetrieve.mockResolvedValue({
        status: "EXECUTING",
        metadata,
        tags: ["user_user-1", "chat_chat-1"],
      } as never);
      const response = await createAgentStatusPost({ endpoint: "/api/agent" })(
        requestFor("chat-1", "run-1"),
      );
      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toEqual({
        status: "INITIALIZING",
        terminal: false,
      });
      expect(mockSetActiveTriggerRun).not.toHaveBeenCalled();
      expect(mockCloseAgentApprovalSession).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      metadata: { userId: "other", chatId: "chat-1" },
      status: "EXECUTING",
      tags: ["user_user-1", "chat_chat-1"],
    },
    ...[{ chatId: "other" }, { userId: "other" }].map((metadata) => ({
      metadata,
      status: "EXECUTING",
      tags: ["user_user-1", "chat_chat-1"],
    })),
    { metadata: {}, status: "EXECUTING", tags: ["user_other", "chat_chat-1"] },
    { metadata: {}, status: "COMPLETED", tags: ["user_other", "chat_chat-1"] },
  ])(
    "rejects mismatched ownership even when server tags or terminal status are present: %j",
    async (run) => {
      const { createAgentStatusPost } = await import("../agent-status-route");
      mockGetChatById.mockResolvedValue({
        id: "chat-1",
        user_id: "user-1",
        active_trigger_run_id: "run-1",
        active_agent_approval_session_id: "approval-1",
      } as never);
      mockRunsRetrieve.mockResolvedValue(run as never);
      const response = await createAgentStatusPost({ endpoint: "/api/agent" })(
        requestFor("chat-1", "run-1"),
      );
      expect(response.status).toBe(403);
      expect(mockSetActiveTriggerRun).not.toHaveBeenCalled();
      expect(mockCloseAgentApprovalSession).not.toHaveBeenCalled();
    },
  );

  it.each(["FAILED", "CRASHED", "COMPLETED"])(
    "clears a tagged approval run that became %s before ownership initialization without replay",
    async (status) => {
      const { createAgentStatusPost } = await import("../agent-status-route");
      mockGetChatById.mockResolvedValue({
        id: "chat-1",
        user_id: "user-1",
        active_trigger_run_id: "run-1",
        active_agent_approval_session_id: "approval-1",
      } as never);
      mockRunsRetrieve.mockResolvedValue({
        status,
        metadata: {},
        tags: ["user_user-1", "chat_chat-1"],
      } as never);
      const response = await createAgentStatusPost({ endpoint: "/api/agent" })(
        requestFor("chat-1", "run-1"),
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        status,
        terminal: true,
      });
      expect(mockCloseAgentApprovalSession).toHaveBeenCalledWith(
        "approval-1",
        "agent-run-terminal",
      );
      expect(mockSetActiveTriggerRun).toHaveBeenCalledWith(
        {
          chatId: "chat-1",
          triggerRunId: null,
          approvalSessionId: null,
          expectedRunId: "run-1",
          clearApprovalPending: true,
        },
        expect.anything(),
      );
      expect(mockRecover).not.toHaveBeenCalled();
    },
  );

  it("preserves a replacement run when an uninitialized terminal poll becomes stale", async () => {
    const { createAgentStatusPost } = await import("../agent-status-route");
    const chat = {
      id: "chat-1",
      user_id: "user-1",
      active_trigger_run_id: "run-1",
      active_agent_approval_session_id: "approval-1",
    };
    mockGetChatById.mockResolvedValueOnce(chat as never).mockResolvedValueOnce({
      ...chat,
      active_trigger_run_id: "run-2",
    } as never);
    mockRunsRetrieve.mockResolvedValue({
      status: "CRASHED",
      metadata: {},
      tags: ["user_user-1", "chat_chat-1"],
    } as never);

    const response = await createAgentStatusPost({ endpoint: "/api/agent" })(
      requestFor("chat-1", "run-1"),
    );

    await expect(response.json()).resolves.toEqual({
      status: "DETACHED",
      terminal: true,
    });
    expect(mockSetActiveTriggerRun).not.toHaveBeenCalled();
    expect(mockCloseAgentApprovalSession).not.toHaveBeenCalled();
    expect(mockRecover).not.toHaveBeenCalled();
  });

  it("reports a crashed run as terminal when its replay cannot fit, without detaching saved recovery state", async () => {
    const { createAgentStatusPost } = await import("../agent-status-route");
    mockGetChatById.mockResolvedValue({
      id: "chat-1",
      user_id: "user-1",
      active_trigger_run_id: "run-1",
      active_agent_approval_session_id: "approval-1",
    } as never);
    mockRunsRetrieve.mockResolvedValue({
      status: "CRASHED",
      metadata: { chatId: "chat-1", userId: "user-1" },
    } as never);
    mockRecover.mockRejectedValueOnce(
      new AgentCrashRecoveryReplayLimitError({
        replay_limit_diagnostic_version: 1,
        replay_prefix_bytes: 0,
        replay_discarded_prefix_bytes: 0,
        replay_prefix_record_count: 0,
        replay_crossing_record_bytes: 0,
      }) as never,
    );

    const response = await createAgentStatusPost({ endpoint: "/api/agent" })(
      requestFor("chat-1", "run-1"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "CRASHED",
      terminal: true,
      recovery: "blocked",
    });
    expect(mockSetActiveTriggerRun).not.toHaveBeenCalled();
    expect(mockCloseAgentApprovalSession).not.toHaveBeenCalled();
  });

  it("does not confuse a missing retained stream with a missing run", async () => {
    const { createAgentStatusPost } = await import("../agent-status-route");
    const { ApiError } = await import("@trigger.dev/sdk");
    mockGetChatById.mockResolvedValue({
      id: "chat-1",
      user_id: "user-1",
      active_trigger_run_id: "run-1",
    } as never);
    mockRunsRetrieve.mockResolvedValue({
      status: "CRASHED",
      metadata: { chatId: "chat-1", userId: "user-1" },
    } as never);
    const error = Object.assign(
      new ApiError(
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
      ),
      { status: 404 },
    );
    mockRecover.mockRejectedValueOnce(error as never);
    await expect(
      createAgentStatusPost({ endpoint: "/api/agent" })(
        requestFor("chat-1", "run-1"),
      ),
    ).rejects.toThrow("unexpected route error");
    expect(mockSetActiveTriggerRun).not.toHaveBeenCalled();
  });

  it("does not convert an untyped recovery failure with the same message into a terminal result", async () => {
    const { createAgentStatusPost } = await import("../agent-status-route");
    mockGetChatById.mockResolvedValue({
      id: "chat-1",
      user_id: "user-1",
      active_trigger_run_id: "run-1",
    } as never);
    mockRunsRetrieve.mockResolvedValue({
      status: "CRASHED",
      metadata: { chatId: "chat-1", userId: "user-1" },
    } as never);
    mockRecover.mockRejectedValueOnce(
      new Error("Agent crash recovery replay budget exceeded") as never,
    );
    await expect(
      createAgentStatusPost({ endpoint: "/api/agent" })(
        requestFor("chat-1", "run-1"),
      ),
    ).rejects.toThrow("unexpected route error");
    expect(mockSetActiveTriggerRun).not.toHaveBeenCalled();
  });

  it("awaits crash recovery before detaching and leaves mapping intact on failure", async () => {
    const { createAgentStatusPost } = await import("../agent-status-route");
    mockGetChatById.mockResolvedValue({
      id: "chat-1",
      user_id: "user-1",
      active_trigger_run_id: "run-1",
    } as never);
    mockRunsRetrieve.mockResolvedValue({
      status: "CRASHED",
      metadata: { chatId: "chat-1", userId: "user-1" },
    } as never);
    let done!: (value: never) => void;
    mockRecover.mockReturnValueOnce(
      new Promise((resolve) => {
        done = resolve;
      }),
    );
    const pending = createAgentStatusPost({ endpoint: "/api/agent" })(
      requestFor("chat-1", "run-1"),
    );
    for (let i = 0; i < 10 && mockRecover.mock.calls.length === 0; i++)
      await Promise.resolve();
    expect(mockRecover).toHaveBeenCalledTimes(1);
    expect(mockSetActiveTriggerRun).not.toHaveBeenCalled();
    done("recovered" as never);
    await pending;
    expect(mockSetActiveTriggerRun).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRunId: "run-1", recoveredCrash: true }),
      expect.anything(),
    );
    mockSetActiveTriggerRun.mockClear();
    mockRecover.mockRejectedValueOnce(
      new Error("fixture recovery unavailable") as never,
    );
    await expect(
      createAgentStatusPost({ endpoint: "/api/agent" })(
        requestFor("chat-1", "run-1"),
      ),
    ).rejects.toThrow("unexpected route error");
    expect(mockSetActiveTriggerRun).not.toHaveBeenCalled();
  });

  it.each(["newer run", "cancellation fence"])(
    "reports a stale crash detach as detached after a %s wins",
    async (race) => {
      const { createAgentStatusPost } = await import("../agent-status-route");
      const chat = {
        id: "chat-1",
        user_id: "user-1",
        active_trigger_run_id: "run-1",
      };
      mockGetChatById
        .mockResolvedValueOnce(chat as never)
        .mockResolvedValueOnce(
          (race === "newer run"
            ? { ...chat, active_trigger_run_id: "run-2" }
            : chat) as never,
        );
      mockRunsRetrieve.mockResolvedValue({
        status: "CRASHED",
        metadata: { chatId: "chat-1", userId: "user-1" },
      } as never);
      if (race === "cancellation fence")
        mockSetActiveTriggerRun.mockResolvedValueOnce("stale" as never);

      const response = await createAgentStatusPost({ endpoint: "/api/agent" })(
        requestFor("chat-1", "run-1"),
      );

      await expect(response.json()).resolves.toEqual({
        status: "DETACHED",
        terminal: true,
      });
      expect(mockRecover).toHaveBeenCalledTimes(1);
      expect(mockSetActiveTriggerRun).toHaveBeenCalledTimes(
        race === "newer run" ? 0 : 1,
      );
    },
  );

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
    // The ownership read always carries its own bounded client.
    expect(mockGetChatById).toHaveBeenCalledWith(
      { id: "chat-1" },
      expect.objectContaining({ signal: expect.anything() }),
    );
    // Exactly one read of the owned active run, with the body callback, a
    // single SDK attempt (the browser's next poll is the retry), its own
    // cancellation signal and no payload/output hydration.
    expect(mockRunsRetrieve).toHaveBeenCalledTimes(1);
    const [readRunId, readOptions] = mockRunsRetrieve.mock.calls[0] as [
      unknown,
      {
        onResponseBody?: unknown;
        retry?: unknown;
        signal?: AbortSignal;
        prepareData?: (data: unknown, response: unknown) => unknown;
      },
    ];
    expect(readRunId).toBe("run-1");
    expect(Object.keys(readOptions).sort()).toEqual([
      "onResponseBody",
      "prepareData",
      "retry",
      "signal",
    ]);
    expect(readOptions.onResponseBody).toEqual(expect.any(Function));
    expect(readOptions.retry).toEqual({ maxAttempts: 1 });
    const data = { payloadPresignedUrl: "https://fixture.invalid/payload" };
    expect(readOptions.prepareData?.(data, undefined)).toBe(data);
    // A completed read is never aborted.
    expect(readOptions.signal).toBeInstanceOf(AbortSignal);
    expect(readOptions.signal?.aborted).toBe(false);
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
    expect(mockSetActiveTriggerRun).toHaveBeenCalledWith(
      {
        chatId: "chat-1",
        triggerRunId: null,
        approvalSessionId: null,
        expectedRunId: "run-1",
        clearApprovalPending: true,
      },
      expect.anything(),
    );
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

  it.each([false, true])(
    "distinguishes the validated API-body boundary in the slow and deadline warnings of an owned read (observed=%s)",
    async (observed) => {
      const { createAgentStatusPost } = await import("../agent-status-route");
      let finish!: (value: any) => void;
      let options: { onResponseBody?: () => void } | undefined;
      mockRunsRetrieve.mockImplementationOnce(((
        _runId: string,
        value: typeof options,
      ) => {
        options = value;
        return new Promise((resolve) => {
          finish = resolve;
        });
      }) as never);
      authenticateAfter(9_000);
      const request = requestFor("chat-1", "run-1");
      // Untrusted headers and unrelated body content must never enter telemetry.
      request.headers.get = () => "PRIVATE_HEADER";
      request.json = async () => ({
        chatId: "chat-1",
        runId: "run-1",
        prompt: "PRIVATE_REQUEST",
      });
      let settled = false;
      const pending = createAgentStatusPost({ endpoint: "/api/agent" })(
        request,
      ).finally(() => {
        settled = true;
      });
      await jest.advanceTimersByTimeAsync(10_000);
      const [first] = warningsFor("agent_status_slow_request");
      expect(first).toMatchObject({
        stage: "retrieve_trigger_run",
        chat_id: "chat-1",
        trigger_run_id: "run-1",
        elapsed_ms: 10_000,
        warning_threshold_ms: 10_000,
        trigger_run_read_diagnostic_version: 1,
        trigger_run_read_api_body: "not_observed",
        trigger_run_read_api_body_elapsed_ms: null,
      });
      await jest.advanceTimersByTimeAsync(1_000);
      if (observed && options?.onResponseBody)
        Reflect.apply(options.onResponseBody, undefined, [
          new Proxy(
            {},
            {
              get() {
                throw new Error("PRIVATE_BODY_READ");
              },
            },
          ),
        ]);
      // The read began at 9s, so its 5s deadline answers at 14s.
      await jest.advanceTimersByTimeAsync(2_999);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      const response = await pending;
      expect(response.status).toBe(503);
      const [deadline] = warningsFor("agent_status_trigger_read_deadline");
      expect(deadline).toMatchObject({
        stage: "retrieve_trigger_run",
        chat_id: "chat-1",
        trigger_run_id: "run-1",
        elapsed_ms: 14_000,
        trigger_run_read_deadline_ms: 5_000,
        trigger_run_read_diagnostic_version: 1,
        trigger_run_read_api_body: observed
          ? "validated_body_observed"
          : "not_observed",
        trigger_run_read_api_body_elapsed_ms: observed ? 2_000 : null,
        trigger_run_read_api_body_elapsed_capped: false,
      });
      expect(JSON.stringify(jest.mocked(console.warn).mock.calls)).not.toMatch(
        /PRIVATE/,
      );
      // Settlement after the response is ignored and adds no warnings.
      finish({
        status: "COMPLETED",
        metadata: { chatId: "chat-1", userId: "user-1" },
      });
      await jest.advanceTimersByTimeAsync(60_000);
      expect(warningsFor("agent_status_slow_request")).toHaveLength(1);
      expect(warningsFor("agent_status_trigger_read_deadline")).toHaveLength(1);
      expect(mockSetActiveTriggerRun).not.toHaveBeenCalled();
    },
  );

  it.each(["rejects as soon as it is aborted", "resolves later anyway"])(
    "answers a hanging owned read with a retryable 503 at 5s, aborts it, and ignores a lookup that %s",
    async (late) => {
      const { createAgentStatusPost } = await import("../agent-status-route");
      const { handleAgentRouteError } = await import("../agent-route-errors");
      const { ApiError } = await import("@trigger.dev/sdk");
      mockGetChatById.mockResolvedValue({
        id: "chat-1",
        user_id: "user-1",
        active_trigger_run_id: "run-1",
        active_agent_approval_session_id: "approval-1",
      } as never);
      let signal!: AbortSignal;
      let resolveLate!: (value: unknown) => void;
      mockRunsRetrieve.mockImplementationOnce(((
        _runId: string,
        options: { signal: AbortSignal },
      ) => {
        signal = options.signal;
        return new Promise((resolve, reject) => {
          resolveLate = resolve;
          // Like the SDK's real fetch: an aborted request rejects at once with
          // its own (here: missing-looking) error. It must not replace the 503.
          if (late === "rejects as soon as it is aborted")
            signal.addEventListener("abort", () =>
              reject(
                Object.assign(
                  new ApiError(
                    undefined as never,
                    undefined as never,
                    undefined as never,
                    undefined as never,
                  ),
                  { status: 404 },
                ),
              ),
            );
        });
      }) as never);
      // Attached before the deadline: the abort-driven rejection happens then.
      const unhandled = jest.fn();
      process.on("unhandledRejection", unhandled);
      let settled = false;
      const pending = createAgentStatusPost({ endpoint: "/api/agent-long" })(
        requestFor("chat-1", "run-1"),
      ).finally(() => {
        settled = true;
      });
      await jest.advanceTimersByTimeAsync(4_999);
      expect(settled).toBe(false);
      expect(signal.aborted).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      const response = await pending;
      expect(signal.aborted).toBe(true);

      // The response body is asserted with real scheduling in
      // agent-crash-status-polling; here the typed error is the contract.
      expect(response.status).toBe(503);
      expect(handleAgentRouteError).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            type: "offline",
            surface: "api",
            statusCode: 503,
          }),
          endpoint: "/api/agent-long",
          action: "status",
          context: expect.objectContaining({
            stage: "retrieve_trigger_run",
            chatId: "chat-1",
            runId: "run-1",
          }),
        }),
      );
      expect(warningsFor("agent_route_service_unavailable")).toEqual([
        expect.objectContaining({
          endpoint: "/api/agent-long",
          action: "status",
          stage: "retrieve_trigger_run",
          error_code: "offline:api",
          http_status: 503,
        }),
      ]);
      expect(warningsFor("agent_status_trigger_read_deadline")).toEqual([
        expect.objectContaining({
          endpoint: "/api/agent-long",
          trigger_run_read_api_body: "not_observed",
          trigger_run_read_deadline_ms: 5_000,
        }),
      ]);
      // A timeout is not evidence the run ended or is missing: the active
      // association, approval session and run are left exactly as they were.
      expect(mockRunsRetrieve).toHaveBeenCalledTimes(1);
      expect(mockGetChatById).toHaveBeenCalledTimes(1);

      try {
        resolveLate({
          status: "COMPLETED",
          metadata: { chatId: "chat-1", userId: "user-1" },
        });
        await new Promise((resolve) =>
          jest
            .requireActual<typeof import("node:timers")>("node:timers")
            .setImmediate(resolve),
        );
        await jest.advanceTimersByTimeAsync(60_000);
      } finally {
        process.off("unhandledRejection", unhandled);
      }
      expect(unhandled).not.toHaveBeenCalled();
      expect(handleAgentRouteError).toHaveBeenCalledTimes(1);
      expect(mockGetChatById).toHaveBeenCalledTimes(1);
      expect(mockSetActiveTriggerRun).not.toHaveBeenCalled();
      expect(mockCloseAgentApprovalSession).not.toHaveBeenCalled();
      expect(mockRecover).not.toHaveBeenCalled();
      expect(warningsFor("agent_status_slow_request")).toHaveLength(0);
    },
  );

  describe("status read transport", () => {
    const originalApiURL = process.env.TRIGGER_API_URL;
    let previousObserver: unknown;
    beforeEach(() => {
      previousObserver = serviceTransportRuntime[serviceTransportObserverKey];
      delete process.env.TRIGGER_API_URL;
    });
    afterEach(() => {
      serviceTransportRuntime[serviceTransportObserverKey] =
        previousObserver as never;
      if (originalApiURL === undefined) delete process.env.TRIGGER_API_URL;
      else process.env.TRIGGER_API_URL = originalApiURL;
    });

    it("reports the latest matching dispatch phase and a saturated count in the slow and deadline warnings", async () => {
      registerServiceTransportObserver();
      const { createAgentStatusPost } = await import("../agent-status-route");
      const dispatches: object[] = [];
      let finish!: (value: unknown) => void;
      authenticateAfter(8_000);
      mockRunsRetrieve.mockImplementationOnce(() => {
        // The SDK dispatches inside the caller's async context; these are the
        // env/default target's exact Undici request messages.
        channel("undici:request:create").publish({
          request: {
            origin: "https://api.trigger.dev",
            path: "/api/v3/runs/run-1",
            method: "POST",
          },
        });
        for (let attempt = 0; attempt < 20; attempt++) {
          const request = {
            origin: "https://api.trigger.dev",
            path: "/api/v3/runs/run-1",
            method: "GET",
          };
          dispatches.push(request);
          channel("undici:request:create").publish({ request });
        }
        channel("undici:client:sendHeaders").publish({
          request: dispatches[19],
          socket: {},
        });
        return new Promise((resolve) => {
          finish = resolve;
        });
      });
      const pending = createAgentStatusPost({ endpoint: "/api/agent" })(
        requestFor("chat-1", "run-1"),
      );
      await jest.advanceTimersByTimeAsync(10_000);
      channel("undici:request:headers").publish({ request: dispatches[19] });
      // The read began at 8s; its deadline snapshot is taken at 13s.
      await jest.advanceTimersByTimeAsync(3_000);
      const response = await pending;
      expect(response.status).toBe(503);
      const logs = jest
        .mocked(console.warn)
        .mock.calls.map(([line]) => JSON.parse(line as string))
        .filter((log) => "trigger_run_read_api_body" in log);
      expect(logs.map((log) => log.event)).toEqual([
        "agent_status_slow_request",
        "agent_status_trigger_read_deadline",
      ]);
      expect(
        logs.map((log) => [
          log.stage,
          log.trigger_run_read_api_body,
          log.trigger_run_read_transport_diagnostic_version,
          log.trigger_run_read_transport_state,
          log.trigger_run_read_transport_request_count,
          log.trigger_run_read_transport_request_count_capped,
        ]),
      ).toEqual([
        [
          "retrieve_trigger_run",
          "not_observed",
          1,
          "socket_assigned",
          16,
          true,
        ],
        [
          "retrieve_trigger_run",
          "not_observed",
          1,
          "response_headers_received",
          16,
          true,
        ],
      ]);
      expect(JSON.stringify(logs)).not.toMatch(
        /api\.trigger\.dev|api\/v3|socket_(connection|prior|previous)|node_/,
      );
      // finish() released the observer: a late response changes nothing.
      finish({
        status: "EXECUTING",
        metadata: { chatId: "chat-1", userId: "user-1" },
      });
      await jest.advanceTimersByTimeAsync(60_000);
      expect(
        jest
          .mocked(console.warn)
          .mock.calls.filter(([line]) =>
            String(line).includes("trigger_run_read_api_body"),
          ),
      ).toHaveLength(2);
      expect(mockRunsRetrieve).toHaveBeenCalledTimes(1);
    });

    it.each(["resolved", "missing", "failed", "timed out"])(
      "keeps the %s read outcome and its body warnings when the observer throws",
      async (outcome) => {
        const fail = () => {
          throw new Error("PRIVATE_OBSERVER");
        };
        serviceTransportRuntime[serviceTransportObserverKey] = () => ({
          run: fail,
          snapshot: fail,
          finish: fail,
        });
        const { createAgentStatusPost } = await import("../agent-status-route");
        const { ApiError } = await import("@trigger.dev/sdk");
        let settle!: () => void;
        mockRunsRetrieve.mockImplementationOnce(
          () =>
            new Promise((resolve, reject) => {
              settle = () => {
                if (outcome === "resolved")
                  resolve({
                    status: "EXECUTING",
                    metadata: { chatId: "chat-1", userId: "user-1" },
                  });
                else if (outcome === "missing") {
                  const missing = Object.assign(new Error("missing"), {
                    status: 404,
                  });
                  Object.setPrototypeOf(missing, ApiError.prototype);
                  reject(missing);
                } else reject(new Error("provider unavailable"));
              };
            }),
        );
        authenticateAfter(9_000);
        const pending = createAgentStatusPost({ endpoint: "/api/agent" })(
          requestFor("chat-1", "run-1"),
        );
        await jest.advanceTimersByTimeAsync(10_000);
        if (outcome === "timed out") await jest.advanceTimersByTimeAsync(4_000);
        else settle();
        if (outcome === "failed")
          await expect(pending).rejects.toThrow("unexpected route error");
        else
          expect((await pending).status).toBe(
            { resolved: 200, missing: 404, "timed out": 503 }[outcome],
          );
        const logs = jest
          .mocked(console.warn)
          .mock.calls.map(([line]) => JSON.parse(line as string))
          .filter((log) => "trigger_run_read_api_body" in log);
        expect(logs.map((log) => log.event)).toEqual(
          outcome === "timed out"
            ? [
                "agent_status_slow_request",
                "agent_status_trigger_read_deadline",
              ]
            : ["agent_status_slow_request"],
        );
        for (const log of logs)
          expect(log).toMatchObject({
            stage: "retrieve_trigger_run",
            trigger_run_read_diagnostic_version: 1,
            trigger_run_read_api_body: "not_observed",
            trigger_run_read_transport_state: "unavailable",
            trigger_run_read_transport_request_count: 0,
          });
        expect(JSON.stringify(logs)).not.toContain("PRIVATE");
        expect(mockRunsRetrieve).toHaveBeenCalledTimes(1);
        const warnings = jest.mocked(console.warn).mock.calls.length;
        await jest.advanceTimersByTimeAsync(60_000);
        expect(console.warn).toHaveBeenCalledTimes(warnings);
      },
    );
  });

  it.each(["/api/agent", "/api/agent-long"] as const)(
    "observes the pending AuthKit subphase on %s without changing request completion",
    async (endpoint) => {
      const { createAgentStatusPost } = await import("../agent-status-route");
      const actual = jest.requireActual<
        typeof import("@/lib/auth/get-user-id")
      >("@/lib/auth/get-user-id");
      let finish!: (value: unknown) => void;
      let observeSession: NonNullable<AuthkitOptions["onSessionPhase"]>;
      mockAuthkit.mockImplementationOnce((_, options) => {
        observeSession = (options as AuthkitOptions).onSessionPhase!;
        observeSession("verify_access_token");
        return new Promise((resolve) => {
          finish = resolve;
        });
      });
      mockGetUserIDAndPro.mockImplementationOnce(
        actual.getUserIDAndPro as never,
      );
      const response = createAgentStatusPost({ endpoint })(
        requestFor("chat-1", "run-1"),
      );
      await jest.advanceTimersByTimeAsync(10_000);
      observeSession!("refresh_request");
      (observeSession! as (phase: string) => void)("PRIVATE unexpected phase");
      await jest.advanceTimersByTimeAsync(10_000);
      const logs = jest
        .mocked(console.warn)
        .mock.calls.map(([line]) => JSON.parse(line as string));
      expect(logs).toHaveLength(2);
      expect(
        logs.map((log) => [
          log.stage,
          log.auth_phase_diagnostic_version,
          log.auth_phase,
          log.authkit_session_phase,
          log.warning_threshold_ms,
        ]),
      ).toEqual([
        ["authenticate", 1, "session", "verify_access_token", 10_000],
        ["authenticate", 1, "session", "refresh_request", 20_000],
      ]);
      finish({
        session: {
          user: { id: "user-1", email: "PRIVATE@example.org" },
          entitlements: [],
          accessToken: "PRIVATE token",
        },
      });
      expect((await response).status).toBe(200);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(console.warn).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(logs)).not.toContain("PRIVATE");
    },
  );

  it("rejects unexpected phase values instead of exporting them", async () => {
    const { createAgentStatusPost } = await import("../agent-status-route");
    let finish!: (value: unknown) => void;
    mockGetUserIDAndPro.mockImplementationOnce((...args: unknown[]) => {
      (args[1] as (phase: unknown) => void)("PRIVATE future value");
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const response = createAgentStatusPost({ endpoint: "/api/agent" })(
      requestFor("chat-1", "run-1"),
    );
    await jest.advanceTimersByTimeAsync(10_000);
    const log = JSON.parse(
      jest.mocked(console.warn).mock.calls[0][0] as string,
    );
    expect(log.auth_phase).toBe("not_observed");
    expect(JSON.stringify(log)).not.toContain("PRIVATE");
    finish({ userId: "user-1" });
    expect((await response).status).toBe(200);
  });

  // The owned Trigger read is bounded before the first threshold; its slow
  // and deadline warnings are covered by the owned-read tests above.
  it.each([
    "read_request",
    "authenticate",
    "get_chat",
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
        clear_terminal_trigger_run: undefined,
      };
      if (stage === "read_request") request.json = () => pending;
      if (stage === "authenticate")
        mockGetUserIDAndPro.mockReturnValueOnce(pending);
      if (stage === "get_chat") mockGetChatById.mockReturnValueOnce(pending);
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
        warning_threshold_ms: 10_000,
        timer_lateness_ms: 0,
      });
      if (
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

  it("identifies both thresholds when warning callbacks are delayed", async () => {
    const { createAgentStatusPost } = await import("../agent-status-route");
    const startedAt = Date.now();
    let finish!: (value: any) => void;
    mockGetChatById.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const pending = createAgentStatusPost({ endpoint: "/api/agent" })(
      requestFor("chat-1", "run-1"),
    );
    await jest.advanceTimersByTimeAsync(0);
    const clock = jest.spyOn(Date, "now").mockReturnValue(startedAt + 20_245);
    try {
      await jest.advanceTimersByTimeAsync(20_000);
      expect(console.warn).toHaveBeenCalledTimes(2);
      const warnings = jest
        .mocked(console.warn)
        .mock.calls.map(([value]) => JSON.parse(String(value)));
      expect(warnings).toEqual([
        expect.objectContaining({
          stage: "get_chat",
          elapsed_ms: 20_245,
          warning_threshold_ms: 10_000,
          timer_lateness_ms: 10_245,
        }),
        expect.objectContaining({
          stage: "get_chat",
          elapsed_ms: 20_245,
          warning_threshold_ms: 20_000,
          timer_lateness_ms: 245,
        }),
      ]);
    } finally {
      clock.mockRestore();
      finish({
        id: "chat-1",
        user_id: "user-1",
        active_trigger_run_id: "run-1",
      });
      expect((await pending).status).toBe(200);
    }
    expect(mockGetChatById).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("cancels the second warning when a slow request completes", async () => {
    const { createAgentStatusPost } = await import("../agent-status-route");
    let finish!: (value: any) => void;
    mockRunsRetrieve.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    authenticateAfter(9_000);
    const response = createAgentStatusPost({ endpoint: "/api/agent" })(
      requestFor("chat-1", "run-1"),
    );
    await jest.advanceTimersByTimeAsync(10_000);
    expect(console.warn).toHaveBeenCalledTimes(1);
    finish({
      status: "EXECUTING",
      metadata: { chatId: "chat-1", userId: "user-1" },
    });
    expect((await response).status).toBe(200);
    // Both the remaining warning and the read deadline are cleared.
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
      // Enter the bounded read 4s before the second threshold.
      await jest.advanceTimersByTimeAsync(6_000);
      authenticate({ userId: "user-1" });
      await jest.advanceTimersByTimeAsync(4_000);
      const logs = jest
        .mocked(console.warn)
        .mock.calls.map(([line]) => JSON.parse(line as string));
      expect(logs.map((log) => log.stage)).toEqual([
        "authenticate",
        "retrieve_trigger_run",
      ]);
      expect(logs[0]).toMatchObject({
        auth_phase_diagnostic_version: 1,
        auth_phase: "not_observed",
      });
      expect(logs[1]).not.toHaveProperty("auth_phase");
      expect(logs[1]).not.toHaveProperty("auth_phase_diagnostic_version");
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
