/**
 * @jest-environment node
 */
import type { UIMessageStreamWriter } from "ai";

import { logger as triggerLogger } from "@trigger.dev/sdk";

import { ChatSDKError } from "@/lib/errors";
import {
  signAgentToolApprovalInput,
  verifyAgentToolApprovalInputAuthorization,
} from "@/lib/chat/agent-approval-authorization";
import {
  AGENT_APPROVAL_WAIT_CANCELLATION_RECORD,
  createAgentApprovalSessionWaits,
  type AgentApprovalSessionWaitResult,
} from "@/lib/chat/agent-approval-session-waits";
import { buildAgentToolApprovalRequester } from "@/lib/chat/agent-tool-approval-requester";
import {
  AGENT_TOOL_APPROVAL_PROTOCOL_VERSION,
  type AgentToolApprovalInputRecord,
  type AgentToolApprovalRequest,
} from "@/types";

type PendingWait = {
  resolve: (result: AgentApprovalSessionWaitResult<unknown>) => void;
  reject: (error: unknown) => void;
};

const mockSessionWaits: PendingWait[] = [];
const mockSessionSend = jest.fn((_record: unknown) => new Promise(() => {}));
const mockSessionWait = jest.fn(
  (_options: { timeout: string }) =>
    new Promise<AgentApprovalSessionWaitResult<unknown>>((resolve, reject) => {
      mockSessionWaits.push({ resolve, reject });
    }),
);
const mockSessionsOpen = jest.fn((_sessionId: string) => ({
  in: { wait: mockSessionWait, send: mockSessionSend },
}));
const mockSetActiveAgentApprovalPending = jest.fn(
  async (_input: { pending: boolean }): Promise<string> => "acquired",
);
const mockWaitFor = jest.fn(
  async (_duration: { seconds: number }): Promise<void> => undefined,
);

jest.mock("@trigger.dev/sdk", () => {
  const metadata = {
    set: jest.fn(() => metadata),
    flush: jest.fn(async () => undefined),
  };
  return {
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    metadata,
    wait: {
      for: (duration: { seconds: number }) => mockWaitFor(duration),
    },
    sessions: { open: (sessionId: string) => mockSessionsOpen(sessionId) },
  };
});
jest.mock("@/lib/db/actions", () => ({
  setActiveAgentApprovalPending: (input: { pending: boolean }) =>
    mockSetActiveAgentApprovalPending(input),
}));
jest.mock("@/lib/posthog/server", () => ({ phLogger: { event: jest.fn() } }));

const SECRET = "test-agent-approval-secret";
const APPROVAL_SESSION_ID = "session-1";

const request: AgentToolApprovalRequest = {
  toolCallId: "tool-call-1",
  toolName: "run_terminal_cmd",
  operation: "terminal_execute",
  target: "nmap -sV 10.0.0.5",
};

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const track = <T>(promise: Promise<T>) => {
  const state: { settled: boolean; value?: T } = { settled: false };
  void promise.then((value) => {
    state.settled = true;
    state.value = value;
  });
  return state;
};

const pendingApprovalId = (): string => {
  const pendingWrites = mockSetActiveAgentApprovalPending.mock.calls
    .map(
      ([input]) =>
        input as { pending: boolean; request?: { approvalId: string } },
    )
    .filter((input) => input.pending);
  const approvalId = pendingWrites.at(-1)?.request?.approvalId;
  if (!approvalId) throw new Error("No approval request was claimed");
  return approvalId;
};

const signedDecision = (
  approvalId: string,
  decision: "approve" | "deny",
  message?: string,
  toolCallId = request.toolCallId,
): AgentToolApprovalInputRecord =>
  signAgentToolApprovalInput(
    {
      type: "agent-tool-approval",
      protocolVersion: AGENT_TOOL_APPROVAL_PROTOCOL_VERSION,
      approvalId,
      toolCallId,
      decision,
      grant: "full_access",
      ...(message ? { message } : {}),
      at: Date.now(),
      authorization: {
        issuedAt: Date.now(),
        userId: "user-1",
        chatId: "chat-1",
        runId: "run-1",
        approvalSessionId: APPROVAL_SESSION_ID,
        subscription: "pro",
      },
    },
    { secret: SECRET },
  );

const buildRequester = ({
  approvalSessionWaits = createAgentApprovalSessionWaits(),
  signal = new AbortController().signal,
  onApprovalExpired = jest.fn(),
}: {
  approvalSessionWaits?: ReturnType<typeof createAgentApprovalSessionWaits>;
  signal?: AbortSignal;
  onApprovalExpired?: () => void;
} = {}) => {
  const onPostWaitAuthorizationDenied = jest.fn();
  const writer = {
    write: jest.fn(),
    merge: jest.fn(),
    onError: undefined,
  } as unknown as UIMessageStreamWriter;
  const revalidateAfterSuspend = jest.fn(
    async (input: AgentToolApprovalInputRecord) => {
      verifyAgentToolApprovalInputAuthorization({
        input,
        secret: SECRET,
        expected: {
          userId: "user-1",
          chatId: "chat-1",
          runId: "run-1",
          approvalSessionId: APPROVAL_SESSION_ID,
          approvalId: input.approvalId,
          // The requester itself rejects input for another tool call.
          toolCallId: input.toolCallId,
        },
      });
    },
  );
  const requester = buildAgentToolApprovalRequester({
    agentPermissionMode: "ask_approval",
    approvalSessionId: APPROVAL_SESSION_ID,
    approvalSessionWaits,
    writer,
    chatId: "chat-1",
    userId: "user-1",
    runId: "run-1",
    signal,
    activeRuntimeBudget: { pause: jest.fn(), resume: jest.fn() },
    resolveSandboxIdentity: async () => "e2b",
    revalidateAfterSuspend,
    revalidateAfterAutoReview: jest.fn(async () => undefined),
    autoReviewAuthorizationContext: { text: "", complete: true },
    autoReviewConversationContext: { text: "", complete: true },
    onAutoReviewCircuitBreaker: jest.fn(),
    onPostWaitAuthorizationDenied,
    onApprovalExpired,
  });
  if (!requester) throw new Error("Expected an approval requester");
  return {
    requester,
    writer,
    revalidateAfterSuspend,
    onPostWaitAuthorizationDenied,
  };
};

const approvalRequestsWritten = (writer: UIMessageStreamWriter) =>
  (writer.write as jest.Mock).mock.calls.filter(
    ([part]) => part.type === "tool-approval-request",
  ).length;

const slotClaims = () =>
  mockSetActiveAgentApprovalPending.mock.calls.filter(
    ([input]) => input.pending,
  ).length;

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

beforeEach(() => {
  mockSessionWaits.length = 0;
  jest.clearAllMocks();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("buildAgentToolApprovalRequester session waits", () => {
  it("keeps the task from returning until an abandoned approval wait settles", async () => {
    const approvalSessionWaits = createAgentApprovalSessionWaits();
    const { requester, revalidateAfterSuspend } = buildRequester({
      approvalSessionWaits,
    });

    // The AI SDK may stop awaiting a tool callback; the task still owns it.
    const toolCallback = track(requester(request));
    await flush();
    expect(mockSessionWait).toHaveBeenCalledTimes(1);

    let taskReturned = false;
    const taskFinally = approvalSessionWaits.finish().then(() => {
      taskReturned = true;
    });
    // The wake must be dispatched before a snapshot can be taken.
    expect(mockSessionSend).toHaveBeenCalledTimes(1);
    await flush();

    expect(mockSessionsOpen).toHaveBeenCalledWith(APPROVAL_SESSION_ID);
    expect(mockSessionSend).toHaveBeenCalledTimes(1);
    expect(mockSessionSend).toHaveBeenCalledWith(
      AGENT_APPROVAL_WAIT_CANCELLATION_RECORD,
    );
    expect(taskReturned).toBe(false);
    expect(toolCallback.settled).toBe(false);

    // A restored snapshot can deliver the user's approval long after Stop.
    mockSessionWaits[0].resolve({
      ok: true,
      output: signedDecision(pendingApprovalId(), "approve"),
    });
    await taskFinally;
    await flush();

    expect(taskReturned).toBe(true);
    expect(toolCallback.value).toMatchObject({ approved: false });
    expect(revalidateAfterSuspend).not.toHaveBeenCalled();
    expect(mockSessionWait).toHaveBeenCalledTimes(1);
  });

  it("joins the started wait after Stop and denies input that arrives in the same turn", async () => {
    const stop = new AbortController();
    const { requester, revalidateAfterSuspend } = buildRequester({
      signal: stop.signal,
    });

    const result = track(requester(request));
    await flush();
    expect(mockSessionWait).toHaveBeenCalledTimes(1);

    mockSessionWaits[0].resolve({
      ok: true,
      output: signedDecision(pendingApprovalId(), "approve"),
    });
    stop.abort();
    await flush();

    expect(result.value).toEqual({
      approved: false,
      approvalId: expect.any(String),
      reason: "The Agent run was stopped before approval was received.",
    });
    expect(revalidateAfterSuspend).not.toHaveBeenCalled();
  });

  it("does not resolve a stopped approval until the started wait settles", async () => {
    const stop = new AbortController();
    const { requester } = buildRequester({ signal: stop.signal });

    const result = track(requester(request));
    await flush();
    stop.abort();
    expect(mockSessionSend).toHaveBeenCalledTimes(1);
    await flush();

    expect(mockSessionSend).toHaveBeenCalledTimes(1);
    expect(result.settled).toBe(false);

    mockSessionWaits[0].reject(new Error("waitpoint failed after restore"));
    await flush();

    expect(result.value).toMatchObject({
      approved: false,
      reason: "The Agent run was stopped before approval was received.",
    });
  });

  it("lets the parent's terminal Session close settle a stopped wait whose wake send failed", async () => {
    const approvalSessionWaits = createAgentApprovalSessionWaits();
    const stop = new AbortController();
    const { requester, revalidateAfterSuspend } = buildRequester({
      approvalSessionWaits,
      signal: stop.signal,
    });
    mockSessionSend.mockReturnValueOnce(
      Promise.reject(new Error("session append failed")),
    );

    const toolCallback = track(requester(request));
    await flush();
    stop.abort();
    await flush();
    expect(mockSessionSend).toHaveBeenCalledTimes(1);
    expect(toolCallback.settled).toBe(false);

    // Parent outer finally: close the shared inbox, then join started waits.
    mockSessionWaits[0].resolve({ ok: true, output: { trigger: "close" } });
    await approvalSessionWaits.finish();
    await flush();

    expect(toolCallback.value).toMatchObject({
      approved: false,
      reason: "The Agent run was stopped before approval was received.",
    });
    expect(mockSessionWait).toHaveBeenCalledTimes(1);
    expect(revalidateAfterSuspend).not.toHaveBeenCalled();
  });

  it.each([
    ["flat close record", { trigger: "close" }],
    [
      "Session close message envelope",
      {
        kind: "message",
        payload: {
          chatId: "chat-1",
          trigger: "close",
          closedReason: "agent-run-ended",
        },
      },
    ],
  ])(
    "treats a %s as closed and never waits on that Session again",
    async (_label, closeRecord) => {
      const approvalSessionWaits = createAgentApprovalSessionWaits();
      const { requester, writer } = buildRequester({ approvalSessionWaits });

      const first = track(requester(request));
      const queued = track(
        requester({ ...request, toolCallId: "tool-call-2" }),
      );
      await flush();
      expect(mockSessionWait).toHaveBeenCalledTimes(1);

      mockSessionWaits[0].resolve({ ok: true, output: closeRecord });
      await flush();

      const closedDenial = {
        approved: false,
        approvalId: expect.any(String),
        reason: "The approval session closed before the tool could run.",
      };
      expect(first.value).toEqual(closedDenial);
      expect(queued.value).toEqual(closedDenial);

      // A fallback stream's requester shares the task's wait owner.
      const { requester: fallbackRequester } = buildRequester({
        approvalSessionWaits,
      });
      await expect(fallbackRequester(request)).resolves.toEqual(closedDenial);

      expect(mockSessionWait).toHaveBeenCalledTimes(1);
      expect(approvalRequestsWritten(writer)).toBe(1);
      expect(mockSessionSend).not.toHaveBeenCalled();
      await expect(approvalSessionWaits.finish()).resolves.toBeUndefined();
    },
  );

  it("ignores unrelated and cancellation records, then applies the user's signed approval", async () => {
    const { requester, revalidateAfterSuspend } = buildRequester();

    const result = track(requester(request));
    await flush();
    mockSessionWaits[0].resolve({
      ok: true,
      output: { type: "unrelated-session-record" },
    });
    await flush();
    mockSessionWaits[1].resolve({
      ok: true,
      output: AGENT_APPROVAL_WAIT_CANCELLATION_RECORD,
    });
    await flush();
    mockSessionWaits[2].resolve({
      ok: true,
      output: signedDecision("another-approval", "approve"),
    });
    await flush();
    expect(result.settled).toBe(false);
    expect(revalidateAfterSuspend).not.toHaveBeenCalled();

    mockSessionWaits[3].resolve({
      ok: true,
      output: signedDecision(pendingApprovalId(), "approve"),
    });
    await flush();

    expect(result.value).toEqual({
      approved: true,
      approvalId: pendingApprovalId(),
      sandboxIdentity: "e2b",
    });
    expect(revalidateAfterSuspend).toHaveBeenCalledTimes(1);
    expect(mockSessionSend).not.toHaveBeenCalled();
  });

  it("returns the user's denial message", async () => {
    const { requester, revalidateAfterSuspend } = buildRequester();

    const result = track(requester(request));
    await flush();
    mockSessionWaits[0].resolve({
      ok: true,
      output: signedDecision(pendingApprovalId(), "deny", "wrong host"),
    });
    await flush();

    expect(result.value).toMatchObject({
      approved: false,
      reason:
        "The user denied approval for this operation and said: wrong host",
    });
    expect(revalidateAfterSuspend).not.toHaveBeenCalled();
  });
});

describe("buildAgentToolApprovalRequester approval slot delays", () => {
  const slotUnavailable = {
    approved: false,
    approvalId: expect.any(String),
    reason:
      "The Agent approval request is no longer active. Retry the action if the run is still open.",
  };

  it("keeps the task from returning until a started busy-slot delay settles", async () => {
    const approvalSessionWaits = createAgentApprovalSessionWaits();
    const { requester, writer } = buildRequester({ approvalSessionWaits });
    const delay = deferred<void>();
    mockSetActiveAgentApprovalPending.mockResolvedValueOnce("busy");
    mockWaitFor.mockReturnValueOnce(delay.promise);

    const toolCallback = track(requester(request));
    await flush();
    expect(mockWaitFor).toHaveBeenCalledTimes(1);

    let taskReturned = false;
    const taskFinally = approvalSessionWaits.finish().then(() => {
      taskReturned = true;
    });
    await flush();
    expect(taskReturned).toBe(false);
    expect(toolCallback.settled).toBe(false);

    delay.resolve();
    await taskFinally;
    await flush();

    expect(toolCallback.value).toEqual(slotUnavailable);
    expect(mockWaitFor).toHaveBeenCalledTimes(1);
    expect(slotClaims()).toBe(1);
    expect(mockSessionWait).not.toHaveBeenCalled();
    expect(approvalRequestsWritten(writer)).toBe(0);
  });

  it("does not start a slot delay when a busy response arrives after finish", async () => {
    const approvalSessionWaits = createAgentApprovalSessionWaits();
    const { requester } = buildRequester({ approvalSessionWaits });
    const claim = deferred<string>();
    mockSetActiveAgentApprovalPending.mockReturnValueOnce(claim.promise);

    const toolCallback = track(requester(request));
    await flush();
    expect(slotClaims()).toBe(1);

    const taskFinally = approvalSessionWaits.finish();
    claim.resolve("busy");
    await taskFinally;
    await flush();

    expect(toolCallback.value).toEqual(slotUnavailable);
    expect(mockWaitFor).not.toHaveBeenCalled();
    expect(slotClaims()).toBe(1);
    expect(mockSessionWait).not.toHaveBeenCalled();
  });

  it("does not claim the slot or begin durable waits after the task finished", async () => {
    const approvalSessionWaits = createAgentApprovalSessionWaits();
    const { requester, writer } = buildRequester({ approvalSessionWaits });
    await approvalSessionWaits.finish();

    await expect(requester(request)).resolves.toEqual({
      approved: false,
      approvalId: expect.any(String),
      reason: "The Agent run was stopped before approval was requested.",
    });
    expect(slotClaims()).toBe(0);
    expect(mockWaitFor).not.toHaveBeenCalled();
    expect(mockSessionWait).not.toHaveBeenCalled();
    expect(approvalRequestsWritten(writer)).toBe(0);
  });

  it("starts no slot delay after Stop", async () => {
    const stop = new AbortController();
    stop.abort();
    const { requester } = buildRequester({ signal: stop.signal });

    await expect(requester(request)).resolves.toMatchObject({
      approved: false,
    });
    expect(slotClaims()).toBe(0);
    expect(mockWaitFor).not.toHaveBeenCalled();
    expect(mockSessionWait).not.toHaveBeenCalled();
  });

  it.each([
    ["the task finishes", "finish"],
    ["the user stops the run", "stop"],
  ])(
    "releases a slot acquired after %s without showing or waiting for approval",
    async (_label, cause) => {
      const approvalSessionWaits = createAgentApprovalSessionWaits();
      const stop = new AbortController();
      const { requester, writer } = buildRequester({
        approvalSessionWaits,
        signal: stop.signal,
      });
      const claim = deferred<string>();
      mockSetActiveAgentApprovalPending.mockReturnValueOnce(claim.promise);

      const toolCallback = track(requester(request));
      await flush();
      expect(slotClaims()).toBe(1);

      const taskFinally =
        cause === "finish" ? approvalSessionWaits.finish() : undefined;
      if (cause === "stop") stop.abort();
      claim.resolve("acquired");
      await taskFinally;
      await flush();

      expect(toolCallback.value).toEqual({
        approved: false,
        approvalId: pendingApprovalId(),
        reason: "The Agent run was stopped before approval was requested.",
      });
      expect(approvalRequestsWritten(writer)).toBe(0);
      expect(mockSessionsOpen).not.toHaveBeenCalled();
      expect(mockSessionWait).not.toHaveBeenCalled();
      expect(mockWaitFor).not.toHaveBeenCalled();
      expect(mockSetActiveAgentApprovalPending).toHaveBeenLastCalledWith(
        expect.objectContaining({
          pending: false,
          expectedApprovalId: pendingApprovalId(),
        }),
      );
    },
  );

  it("retries a busy slot while active and then applies the user's signed approval", async () => {
    const { requester, revalidateAfterSuspend } = buildRequester();
    mockSetActiveAgentApprovalPending.mockResolvedValueOnce("busy");

    const result = track(requester(request));
    await flush();
    expect(mockWaitFor).toHaveBeenCalledWith({ seconds: 1 });
    expect(slotClaims()).toBe(2);
    expect(mockSessionWait).toHaveBeenCalledTimes(1);

    mockSessionWaits[0].resolve({
      ok: true,
      output: signedDecision(pendingApprovalId(), "approve"),
    });
    await flush();

    expect(result.value).toEqual({
      approved: true,
      approvalId: pendingApprovalId(),
      sandboxIdentity: "e2b",
    });
    expect(revalidateAfterSuspend).toHaveBeenCalledTimes(1);
  });
});

describe("buildAgentToolApprovalRequester approval slot release recovery", () => {
  const slotReleaseFailed = {
    approved: false,
    approvalId: expect.any(String),
    reason:
      "HackerAI could not finish recording the previous approval, so this operation was not run and no approval was requested. Retry the action; if it fails again, stop and start a new Agent request.",
  };
  // The write's response was lost; it may or may not have committed.
  const lostReleaseResponse = () =>
    new ChatSDKError(
      "bad_request:database",
      "Failed to set active agent approval state",
      { db_error_name: "TypeError", db_outcome_unknown: true },
    );
  /**
   * Models the Convex compare-and-set slot. Each release write either fails
   * before committing ("fail"), commits but loses its response ("lost"), or
   * completes normally ("ok", the default once the script is exhausted).
   */
  const scriptReleases = (...outcomes: Array<"fail" | "lost" | "ok">) => {
    let heldApprovalId: string | undefined;
    mockSetActiveAgentApprovalPending.mockImplementation(async (raw) => {
      const input = raw as {
        pending: boolean;
        request?: { approvalId: string };
        expectedApprovalId?: string;
      };
      if (input.pending) {
        const approvalId = input.request!.approvalId;
        if (heldApprovalId !== undefined && heldApprovalId !== approvalId) {
          return "busy";
        }
        heldApprovalId = approvalId;
        return "acquired";
      }
      const outcome = outcomes.shift() ?? "ok";
      if (outcome === "fail") throw lostReleaseResponse();
      const matches = heldApprovalId === input.expectedApprovalId;
      if (matches) heldApprovalId = undefined;
      if (outcome === "lost") throw lostReleaseResponse();
      return matches ? "released" : "stale";
    });
  };
  const releaseWrites = () =>
    mockSetActiveAgentApprovalPending.mock.calls
      .map(
        ([input]) =>
          input as {
            pending: boolean;
            expectedRunId?: string;
            expectedApprovalSessionId?: string;
            expectedApprovalId?: string;
          },
      )
      .filter((input) => !input.pending)
      .map(
        ({ expectedRunId, expectedApprovalSessionId, expectedApprovalId }) => ({
          expectedRunId,
          expectedApprovalSessionId,
          expectedApprovalId,
        }),
      );
  const guardedRelease = (approvalId: string) => ({
    expectedRunId: "run-1",
    expectedApprovalSessionId: APPROVAL_SESSION_ID,
    expectedApprovalId: approvalId,
  });
  // Covers every in-process retry delay of one bounded release.
  const runReleaseRetries = async () => {
    await jest.advanceTimersByTimeAsync(1_250);
    await flush();
  };

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
    // A busy-slot poll stays pending, so polling a stale slot is observable.
    mockWaitFor.mockImplementation(() => new Promise<void>(() => {}));
  });
  afterEach(() => {
    jest.useRealTimers();
    mockWaitFor.mockImplementation(async () => undefined);
    mockSetActiveAgentApprovalPending.mockImplementation(
      async () => "acquired",
    );
  });

  it.each([
    ["was not committed", "fail" as const],
    ["committed before its response was lost", "lost" as const],
  ])(
    "retries the identical guarded release when the first write %s, then requires a fresh approval for the next action",
    async (_label, firstRelease) => {
      scriptReleases(firstRelease);
      const { requester, writer, revalidateAfterSuspend } = buildRequester();

      const first = track(requester(request));
      const second = track(
        requester({ ...request, toolCallId: "tool-call-2" }),
      );
      await flush();
      const firstApprovalId = pendingApprovalId();
      mockSessionWaits[0].resolve({
        ok: true,
        output: signedDecision(firstApprovalId, "approve"),
      });
      await flush();
      // The queued action may not claim while the release is being retried.
      expect(slotClaims()).toBe(1);

      await runReleaseRetries();

      // The decided approval is honored exactly once.
      expect(first.value).toEqual({
        approved: true,
        approvalId: firstApprovalId,
        sandboxIdentity: "e2b",
      });
      // The retry is the same compare-clear; after a committed write it
      // returns "stale" and clears nothing else.
      expect(releaseWrites()).toEqual([
        guardedRelease(firstApprovalId),
        guardedRelease(firstApprovalId),
      ]);
      expect(triggerLogger.error).toHaveBeenCalledWith(
        "[agent-approval] failed to release approval slot",
        expect.objectContaining({
          approval_id: firstApprovalId,
          attempt: 1,
          will_retry: true,
          cause_error_name: "TypeError",
          outcome_unknown: true,
        }),
      );

      // The next action claims its own slot without busy polling.
      expect(slotClaims()).toBe(2);
      const secondApprovalId = pendingApprovalId();
      expect(secondApprovalId).not.toBe(firstApprovalId);
      expect(mockWaitFor).not.toHaveBeenCalled();
      expect(approvalRequestsWritten(writer)).toBe(2);

      // Replaying the first decision cannot approve the second action.
      mockSessionWaits[1].resolve({
        ok: true,
        output: signedDecision(firstApprovalId, "approve"),
      });
      await flush();
      expect(second.settled).toBe(false);

      mockSessionWaits[2].resolve({
        ok: true,
        output: signedDecision(
          secondApprovalId,
          "approve",
          undefined,
          "tool-call-2",
        ),
      });
      await flush();

      expect(second.value).toEqual({
        approved: true,
        approvalId: secondApprovalId,
        sandboxIdentity: "e2b",
      });
      expect(revalidateAfterSuspend).toHaveBeenCalledTimes(2);
    },
  );

  it("withdraws a granted action when Stop arrives during release", async () => {
    scriptReleases("fail", "ok");
    const stop = new AbortController();
    const { requester } = buildRequester({ signal: stop.signal });
    const result = track(requester(request));
    await flush();
    const approvalId = pendingApprovalId();
    mockSessionWaits[0].resolve({
      ok: true,
      output: signedDecision(approvalId, "approve"),
    });
    await flush();
    expect(releaseWrites()).toHaveLength(1);
    stop.abort();
    await runReleaseRetries();
    expect(result.value).toMatchObject({
      approved: false,
      approvalId,
      reason: "The Agent run was stopped before the operation could start.",
    });
    expect(releaseWrites()).toHaveLength(2);
  });

  it.each(["ok", "fail"] as const)(
    "honors Stop during queued release recovery (%s)",
    async (lastWrite) => {
      scriptReleases("fail", "fail", "fail", "fail", "fail", lastWrite);
      const stop = new AbortController();
      const { requester, writer } = buildRequester({ signal: stop.signal });
      const first = track(requester(request));
      const second = track(
        requester({ ...request, toolCallId: "tool-call-2" }),
      );
      await flush();
      mockSessionWaits[0].resolve({
        ok: true,
        output: signedDecision(pendingApprovalId(), "deny"),
      });
      await flush();
      await runReleaseRetries();
      expect(first.value).toMatchObject({ approved: false });
      expect(releaseWrites()).toHaveLength(4);
      stop.abort();
      await runReleaseRetries();
      expect(second.value).toMatchObject({
        approved: false,
        reason: "The Agent run was stopped before approval was requested.",
      });
      expect(approvalRequestsWritten(writer)).toBe(1);
      expect(slotClaims()).toBe(1);
    },
  );

  it("keeps a denial and denies follow-on actions without polling while the release keeps failing", async () => {
    scriptReleases("fail", "fail", "fail", "fail", "fail", "fail");
    const { requester, writer, revalidateAfterSuspend } = buildRequester();

    const first = track(requester(request));
    const second = track(requester({ ...request, toolCallId: "tool-call-2" }));
    await flush();
    const firstApprovalId = pendingApprovalId();
    mockSessionWaits[0].resolve({
      ok: true,
      output: signedDecision(firstApprovalId, "deny", "wrong host"),
    });
    await flush();
    await runReleaseRetries();

    expect(first.value).toMatchObject({
      approved: false,
      approvalId: firstApprovalId,
      reason:
        "The user denied approval for this operation and said: wrong host",
    });

    // The queued action retries the same release (3 + 3 writes), then fails
    // closed instead of claiming.
    await runReleaseRetries();

    expect(second.value).toEqual(slotReleaseFailed);
    expect(releaseWrites()).toEqual(
      Array(6).fill(guardedRelease(firstApprovalId)),
    );
    expect(slotClaims()).toBe(1);
    expect(mockWaitFor).not.toHaveBeenCalled();
    expect(mockSessionWait).toHaveBeenCalledTimes(1);
    expect(approvalRequestsWritten(writer)).toBe(1);
    expect(revalidateAfterSuspend).not.toHaveBeenCalled();

    // Once the identical release succeeds (script exhausted), a later action
    // asks the user again.
    const third = track(requester({ ...request, toolCallId: "tool-call-3" }));
    await flush();

    expect(releaseWrites()).toEqual(
      Array(7).fill(guardedRelease(firstApprovalId)),
    );
    expect(slotClaims()).toBe(2);
    expect(pendingApprovalId()).not.toBe(firstApprovalId);
    expect(approvalRequestsWritten(writer)).toBe(2);
    expect(mockSessionWait).toHaveBeenCalledTimes(2);
    expect(third.settled).toBe(false);
  });
});

describe("buildAgentToolApprovalRequester approval expiry", () => {
  const T0 = Date.UTC(2026, 10, 16, 12);
  const HOUR = 60 * 60 * 1000;
  const expiredDenial = () => ({
    approved: false,
    approvalId: pendingApprovalId(),
    reason:
      "This approval request expired before a response arrived. The operation was not run, and this Agent run was stopped. Start a new Agent request to try again.",
  });
  let now: jest.SpyInstance<number, []>;
  beforeEach(() => {
    now = jest.spyOn(Date, "now").mockReturnValue(T0);
  });

  it("denies and stops the run at one deadline that malformed or unrelated input does not reset", async () => {
    const onApprovalExpired = jest.fn();
    const { requester, revalidateAfterSuspend } = buildRequester({
      onApprovalExpired,
    });

    const result = track(requester(request));
    await flush();
    expect(mockSessionWait).toHaveBeenLastCalledWith({ timeout: "10800s" });

    now.mockReturnValue(T0 + 2 * HOUR);
    mockSessionWaits[0].resolve({
      ok: true,
      output: { type: "agent-tool-approval", approvalId: 7 },
    });
    await flush();
    expect(mockSessionWait).toHaveBeenLastCalledWith({ timeout: "3600s" });

    now.mockReturnValue(T0 + 2.5 * HOUR);
    mockSessionWaits[1].resolve({
      ok: true,
      output: signedDecision("another-approval", "approve"),
    });
    await flush();
    expect(mockSessionWait).toHaveBeenLastCalledWith({ timeout: "1800s" });
    expect(result.settled).toBe(false);

    now.mockReturnValue(T0 + 3 * HOUR);
    mockSessionWaits[2].resolve({ ok: false, error: new Error("Timed out") });
    await flush();

    expect(result.value).toEqual(expiredDenial());
    expect(onApprovalExpired).toHaveBeenCalledTimes(1);
    expect(revalidateAfterSuspend).not.toHaveBeenCalled();
    expect(mockSessionWait).toHaveBeenCalledTimes(3);
    expect(mockSessionSend).not.toHaveBeenCalled();
    expect(mockSetActiveAgentApprovalPending).toHaveBeenLastCalledWith(
      expect.objectContaining({
        pending: false,
        expectedApprovalId: pendingApprovalId(),
      }),
    );
  });

  it("expires without another waitpoint when unrelated input arrives after the deadline", async () => {
    const onApprovalExpired = jest.fn();
    const { requester } = buildRequester({ onApprovalExpired });

    const result = track(requester(request));
    await flush();
    now.mockReturnValue(T0 + 3 * HOUR + 1);
    mockSessionWaits[0].resolve({ ok: true, output: { type: "unrelated" } });
    await flush();

    expect(result.value).toEqual(expiredDenial());
    expect(onApprovalExpired).toHaveBeenCalledTimes(1);
    expect(mockSessionWait).toHaveBeenCalledTimes(1);
  });

  it("gives the next approval request its own full deadline", async () => {
    const onApprovalExpired = jest.fn();
    const { requester } = buildRequester({ onApprovalExpired });

    const first = track(requester(request));
    await flush();
    now.mockReturnValue(T0 + 3 * HOUR - 60_000);
    mockSessionWaits[0].resolve({
      ok: true,
      output: signedDecision(pendingApprovalId(), "approve"),
    });
    await flush();
    expect(first.value).toMatchObject({ approved: true });

    const second = track(requester(request));
    await flush();
    expect(mockSessionWait).toHaveBeenLastCalledWith({ timeout: "10800s" });
    mockSessionWaits[1].resolve({
      ok: true,
      output: signedDecision(pendingApprovalId(), "approve"),
    });
    await flush();

    expect(second.value).toMatchObject({ approved: true });
    expect(onApprovalExpired).not.toHaveBeenCalled();
  });

  it("reports Stop instead of expiry when the stopped wait times out", async () => {
    const stop = new AbortController();
    const onApprovalExpired = jest.fn();
    const { requester } = buildRequester({
      signal: stop.signal,
      onApprovalExpired,
    });

    const result = track(requester(request));
    await flush();
    stop.abort();
    now.mockReturnValue(T0 + 3 * HOUR);
    mockSessionWaits[0].resolve({ ok: false, error: new Error("Timed out") });
    await flush();

    expect(result.value).toMatchObject({
      approved: false,
      reason: "The Agent run was stopped before approval was received.",
    });
    expect(onApprovalExpired).not.toHaveBeenCalled();
  });

  it("denies a valid approval that is read at the deadline", async () => {
    const onApprovalExpired = jest.fn();
    const { requester, revalidateAfterSuspend } = buildRequester({
      onApprovalExpired,
    });

    const result = track(requester(request));
    await flush();
    // The rounded-up waitpoint or a delayed resume can deliver it late.
    now.mockReturnValue(T0 + 3 * HOUR);
    mockSessionWaits[0].resolve({
      ok: true,
      output: signedDecision(pendingApprovalId(), "approve"),
    });
    await flush();

    expect(result.value).toEqual(expiredDenial());
    expect(onApprovalExpired).toHaveBeenCalledTimes(1);
    expect(revalidateAfterSuspend).not.toHaveBeenCalled();
  });

  it("counts time waiting behind a busy slot", async () => {
    const onApprovalExpired = jest.fn();
    const { requester, writer, onPostWaitAuthorizationDenied } = buildRequester(
      { onApprovalExpired },
    );
    mockSetActiveAgentApprovalPending
      .mockResolvedValueOnce("busy")
      .mockResolvedValueOnce("busy");
    mockWaitFor
      .mockImplementationOnce(async () => {
        now.mockReturnValue(T0 + 2 * HOUR);
      })
      .mockImplementationOnce(async () => {
        now.mockReturnValue(T0 + 3 * HOUR);
      });

    const result = await requester(request);

    expect(result).toEqual(expiredDenial());
    expect(slotClaims()).toBe(2);
    expect(mockSetActiveAgentApprovalPending).not.toHaveBeenCalledWith(
      expect.objectContaining({ pending: false }),
    );
    expect(onApprovalExpired).toHaveBeenCalledTimes(1);
    expect(onPostWaitAuthorizationDenied).not.toHaveBeenCalled();
    expect(mockSessionWait).not.toHaveBeenCalled();
    expect(approvalRequestsWritten(writer)).toBe(0);
  });
});
