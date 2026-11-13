/**
 * @jest-environment node
 */
import type { UIMessageStreamWriter } from "ai";

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
  () =>
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
): AgentToolApprovalInputRecord =>
  signAgentToolApprovalInput(
    {
      type: "agent-tool-approval",
      protocolVersion: AGENT_TOOL_APPROVAL_PROTOCOL_VERSION,
      approvalId,
      toolCallId: request.toolCallId,
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
}: {
  approvalSessionWaits?: ReturnType<typeof createAgentApprovalSessionWaits>;
  signal?: AbortSignal;
} = {}) => {
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
          toolCallId: request.toolCallId,
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
    onPostWaitAuthorizationDenied: jest.fn(),
  });
  if (!requester) throw new Error("Expected an approval requester");
  return { requester, writer, revalidateAfterSuspend };
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

  it("treats a Session close record as closed and never waits on that Session again", async () => {
    const approvalSessionWaits = createAgentApprovalSessionWaits();
    const { requester, writer } = buildRequester({ approvalSessionWaits });

    const first = track(requester(request));
    const queued = track(requester({ ...request, toolCallId: "tool-call-2" }));
    await flush();
    expect(mockSessionWait).toHaveBeenCalledTimes(1);

    mockSessionWaits[0].resolve({ ok: true, output: { trigger: "close" } });
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
  });

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
