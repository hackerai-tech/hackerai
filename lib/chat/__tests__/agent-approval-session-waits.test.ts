/**
 * @jest-environment node
 */
import { verifyAgentToolApprovalInputAuthorization } from "@/lib/chat/agent-approval-authorization";
import {
  AGENT_APPROVAL_WAIT_CANCELLATION_RECORD,
  createAgentApprovalSessionWaits,
  type AgentApprovalSessionWaitResult,
} from "@/lib/chat/agent-approval-session-waits";
import type { AgentToolApprovalInputRecord } from "@/types";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const track = <T>(promise: Promise<T>) => {
  const state: { settled: boolean; value?: T; error?: unknown } = {
    settled: false,
  };
  void promise.then(
    (value) => {
      state.settled = true;
      state.value = value;
    },
    (error: unknown) => {
      state.settled = true;
      state.error = error;
    },
  );
  return state;
};

const createControlledInput = ({
  send = () => new Promise<void>(() => {}),
  onWait,
}: {
  send?: () => Promise<void>;
  onWait?: () => void;
} = {}) => {
  let resolveWait!: (result: AgentApprovalSessionWaitResult<unknown>) => void;
  let rejectWait!: (error: unknown) => void;
  const input = {
    wait: jest.fn(() => {
      onWait?.();
      return new Promise<AgentApprovalSessionWaitResult<unknown>>(
        (resolve, reject) => {
          resolveWait = resolve;
          rejectWait = reject;
        },
      );
    }),
    send: jest.fn(send),
  };
  return {
    input,
    resolveWait: (result: AgentApprovalSessionWaitResult<unknown>) =>
      resolveWait(result),
    rejectWait: (error: unknown) => rejectWait(error),
  };
};

describe("createAgentApprovalSessionWaits", () => {
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };
  beforeEach(() => {
    unhandledRejections.length = 0;
    process.on("unhandledRejection", onUnhandledRejection);
  });
  afterEach(() => {
    process.off("unhandledRejection", onUnhandledRejection);
  });

  it("neither waits nor sends when the request is already stopped", async () => {
    const waits = createAgentApprovalSessionWaits();
    const stop = new AbortController();
    stop.abort();
    const { input } = createControlledInput();

    await expect(
      waits.waitForApprovalInput(input, stop.signal),
    ).resolves.toEqual({ status: "aborted" });
    expect(input.wait).not.toHaveBeenCalled();
    expect(input.send).not.toHaveBeenCalled();
  });

  it("refuses new waits once the task has finished its scope", async () => {
    const waits = createAgentApprovalSessionWaits();
    const finished = waits.finish();
    const { input } = createControlledInput();

    await expect(
      waits.waitForApprovalInput(input, new AbortController().signal),
    ).resolves.toEqual({ status: "aborted" });
    expect(waits.finish()).toBe(finished);
    await expect(finished).resolves.toBeUndefined();
    expect(input.wait).not.toHaveBeenCalled();
    expect(input.send).not.toHaveBeenCalled();
  });

  it("wakes a wait aborted while it registers and still awaits it", async () => {
    const waits = createAgentApprovalSessionWaits();
    const stop = new AbortController();
    const { input, resolveWait } = createControlledInput({
      onWait: () => stop.abort(),
    });

    const outcome = track(waits.waitForApprovalInput(input, stop.signal));
    expect(input.send).toHaveBeenCalledTimes(1);
    await flush();

    expect(input.send).toHaveBeenCalledTimes(1);
    expect(outcome.settled).toBe(false);

    resolveWait({ ok: true, output: AGENT_APPROVAL_WAIT_CANCELLATION_RECORD });
    await flush();
    expect(outcome.value).toEqual({ status: "aborted" });
  });

  it("holds finish until a stopped wait settles, without awaiting the wake send", async () => {
    const waits = createAgentApprovalSessionWaits();
    const stop = new AbortController();
    // The send never settles, as when appending to a closed Session retries.
    const { input, resolveWait } = createControlledInput();

    const outcome = track(waits.waitForApprovalInput(input, stop.signal));
    stop.abort();
    // Dispatched before any microtask: a snapshot may follow immediately.
    expect(input.send).toHaveBeenCalledTimes(1);
    const finished = track(waits.finish());
    await flush();

    expect(input.send).toHaveBeenCalledTimes(1);
    expect(input.send).toHaveBeenCalledWith(
      AGENT_APPROVAL_WAIT_CANCELLATION_RECORD,
    );
    expect(outcome.settled).toBe(false);
    expect(finished.settled).toBe(false);

    resolveWait({ ok: true, output: { type: "agent-tool-approval" } });
    await flush();

    expect(outcome.value).toEqual({ status: "aborted" });
    expect(finished.settled).toBe(true);
    expect(input.send).toHaveBeenCalledTimes(1);
  });

  it("handles a rejected wake send and a wait that rejects after Stop", async () => {
    const waits = createAgentApprovalSessionWaits();
    const { input, rejectWait } = createControlledInput({
      send: () => Promise.reject(new Error("session closed")),
    });

    const outcome = track(
      waits.waitForApprovalInput(input, new AbortController().signal),
    );
    const finished = track(waits.finish());
    expect(waits.isFinished()).toBe(true);
    expect(input.send).toHaveBeenCalledTimes(1);
    await flush();
    expect(finished.settled).toBe(false);

    rejectWait(new Error("waitpoint failed"));
    await flush();

    expect(outcome.value).toEqual({ status: "aborted" });
    expect(finished.settled).toBe(true);
    expect(finished.error).toBeUndefined();
    expect(unhandledRejections).toEqual([]);
  });

  it("propagates a wait failure that was not caused by Stop", async () => {
    const waits = createAgentApprovalSessionWaits();
    const failure = new Error("waitpoint failed");
    const { input, rejectWait } = createControlledInput();

    const outcome = track(
      waits.waitForApprovalInput(input, new AbortController().signal),
    );
    rejectWait(failure);
    await flush();

    expect(outcome.error).toBe(failure);
    expect(input.send).not.toHaveBeenCalled();
    await expect(waits.finish()).resolves.toBeUndefined();
    expect(unhandledRejections).toEqual([]);
  });

  it("remembers a consumed Session close record for later waits", async () => {
    const waits = createAgentApprovalSessionWaits();
    const { input, resolveWait } = createControlledInput();
    const signal = new AbortController().signal;

    const first = track(waits.waitForApprovalInput(input, signal));
    resolveWait({ ok: true, output: { trigger: "close" } });
    await flush();

    expect(first.value).toEqual({ status: "closed" });
    expect(waits.isSessionClosed()).toBe(true);
    await expect(waits.waitForApprovalInput(input, signal)).resolves.toEqual({
      status: "closed",
    });
    expect(input.wait).toHaveBeenCalledTimes(1);
    expect(input.send).not.toHaveBeenCalled();
  });

  it("returns ordinary records to the caller", async () => {
    const waits = createAgentApprovalSessionWaits();
    const { input, resolveWait } = createControlledInput();

    const outcome = track(
      waits.waitForApprovalInput(input, new AbortController().signal),
    );
    resolveWait({ ok: true, output: { type: "unrelated" } });
    await flush();

    expect(outcome.value).toEqual({
      status: "input",
      result: { ok: true, output: { type: "unrelated" } },
    });
    expect(waits.isSessionClosed()).toBe(false);
  });

  it("starts no slot delay once stopped or finished", async () => {
    const stopped = new AbortController();
    stopped.abort();
    const start = jest.fn(async () => undefined);
    const waits = createAgentApprovalSessionWaits();

    await expect(
      waits.waitForApprovalSlot(start, stopped.signal),
    ).resolves.toBe(false);
    await waits.finish();
    await expect(
      waits.waitForApprovalSlot(start, new AbortController().signal),
    ).resolves.toBe(false);
    expect(start).not.toHaveBeenCalled();
  });

  it("holds finish until a started slot delay settles", async () => {
    const waits = createAgentApprovalSessionWaits();
    let endDelay!: () => void;
    const start = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          endDelay = resolve;
        }),
    );

    const delayed = track(
      waits.waitForApprovalSlot(start, new AbortController().signal),
    );
    const finished = track(waits.finish());
    await flush();
    expect(start).toHaveBeenCalledTimes(1);
    expect(delayed.settled).toBe(false);
    expect(finished.settled).toBe(false);

    endDelay();
    await flush();
    expect(delayed.value).toBe(true);
    expect(finished.settled).toBe(true);
  });

  it("propagates a failed slot delay without failing finish", async () => {
    const waits = createAgentApprovalSessionWaits();
    const failure = new Error("wait.for failed");

    const delayed = track(
      waits.waitForApprovalSlot(
        () => Promise.reject(failure),
        new AbortController().signal,
      ),
    );
    await expect(waits.finish()).resolves.toBeUndefined();
    await flush();
    expect(delayed.error).toBe(failure);
    expect(unhandledRejections).toEqual([]);
  });

  it("uses a wake record that cannot pass signed approval validation", () => {
    expect(() =>
      verifyAgentToolApprovalInputAuthorization({
        input:
          AGENT_APPROVAL_WAIT_CANCELLATION_RECORD as unknown as AgentToolApprovalInputRecord,
        secret: "test-agent-approval-secret",
        expected: {
          userId: "user-1",
          chatId: "chat-1",
          runId: "run-1",
          approvalSessionId: "session-1",
          approvalId: "approval-1",
          toolCallId: "tool-call-1",
        },
      }),
    ).toThrow();
  });
});
