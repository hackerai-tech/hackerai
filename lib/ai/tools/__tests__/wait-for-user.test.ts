/** @jest-environment node */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

const createToken = jest.fn<any>();
const forToken = jest.fn<any>();
const setActiveWait = jest.fn<any>();
const captureEvent = jest.fn<any>();

jest.mock("@trigger.dev/sdk", () => ({
  wait: { createToken, forToken },
}));
jest.mock("@/lib/db/agent-user-wait", () => ({
  setActiveAgentUserWait: setActiveWait,
}));
jest.mock("@/lib/posthog/server", () => ({
  phLogger: { event: captureEvent },
}));

const context = {
  chatId: "chat-1",
  userID: "user-1",
  triggerRunId: "run-1",
};

const execute = async (
  overrides: Record<string, unknown> = {},
  toolOptions: {
    signal?: AbortSignal;
    abortRun?: (outcome: "timed_out" | "failed") => void;
    beforeSuspend?: () => Promise<void>;
    pauseActiveTime?: () => void;
    resumeActiveTime?: () => void;
    revalidateAfterSuspend?: (toolCallId: string) => Promise<void>;
  } = {},
  toolCallId = "tool-1",
) => {
  const { createWaitForUserTool } = await import("../wait-for-user");
  const waitTool = createWaitForUserTool({ ...context, ...overrides } as any, {
    pauseActiveTime: jest.fn(),
    resumeActiveTime: jest.fn(),
    ...toolOptions,
  });
  return waitTool.execute?.({}, { toolCallId } as any);
};

describe("wait_for_user", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    createToken.mockResolvedValue({ id: "waitpoint-1" });
    setActiveWait.mockResolvedValue("acquired");
    forToken.mockResolvedValue({
      ok: true,
      output: {
        chatId: "chat-1",
        userId: "user-1",
        runId: "run-1",
        toolCallId: "tool-1",
        replyId: "reply-1",
        text: "Option A",
      },
    });
  });

  it("parks the current run, returns the matching reply, and clears the wait", async () => {
    const abortRun = jest.fn();
    await expect(execute({}, { abortRun })).resolves.toMatchObject({
      success: true,
      wait_outcome: "message_arrived",
      reply: "Option A",
    });
    expect(createToken).toHaveBeenCalledWith({
      idempotencyKey: "agent-user-wait:run-1:tool-1",
      timeout: "3h",
    });
    expect(setActiveWait).toHaveBeenNthCalledWith(1, {
      chatId: "chat-1",
      userId: "user-1",
      runId: "run-1",
      toolCallId: "tool-1",
      tokenId: "waitpoint-1",
    });
    expect(setActiveWait).toHaveBeenNthCalledWith(2, {
      chatId: "chat-1",
      userId: "user-1",
      runId: "run-1",
      toolCallId: "tool-1",
    });
    expect(captureEvent).toHaveBeenCalledWith(
      "agent_wait_for_user_started",
      expect.not.objectContaining({ reply: expect.anything() }),
    );
    expect(abortRun).not.toHaveBeenCalled();
  });

  it("refuses a reply for a different run", async () => {
    const abortRun = jest.fn();
    forToken.mockResolvedValue({
      ok: true,
      output: {
        chatId: "chat-1",
        userId: "user-1",
        runId: "another-run",
        toolCallId: "tool-1",
        text: "Option A",
      },
    });
    await expect(execute({}, { abortRun })).resolves.toMatchObject({
      success: false,
    });
    expect(setActiveWait).toHaveBeenCalledTimes(2);
    expect(abortRun).toHaveBeenCalledTimes(1);
  });

  it("does not park when a newer run owns the chat", async () => {
    setActiveWait.mockResolvedValue("stale");
    await expect(execute()).resolves.toMatchObject({ success: false });
    expect(forToken).not.toHaveBeenCalled();
  });

  it("reports timeout and releases the reply slot", async () => {
    const abortRun = jest.fn();
    forToken.mockResolvedValue({ ok: false, error: new Error("timed out") });
    await expect(execute({}, { abortRun })).resolves.toMatchObject({
      success: false,
      wait_outcome: "timed_out",
    });
    expect(setActiveWait).toHaveBeenCalledTimes(2);
    expect(abortRun).toHaveBeenCalledTimes(1);
    expect(abortRun).toHaveBeenCalledWith("timed_out");
  });

  it("aborts if preparation fails before the wait starts", async () => {
    const abortRun = jest.fn();
    const error = new Error("could not release the free-run lock");
    await expect(
      execute(
        {},
        {
          abortRun,
          beforeSuspend: async () => {
            throw error;
          },
        },
      ),
    ).rejects.toBe(error);
    expect(abortRun).toHaveBeenCalledTimes(1);
    expect(forToken).not.toHaveBeenCalled();
    expect(setActiveWait).toHaveBeenCalledTimes(2);
  });

  it("aborts if Trigger rejects while suspended", async () => {
    const abortRun = jest.fn();
    const error = new Error("waitpoint unavailable");
    forToken.mockRejectedValue(error);
    await expect(execute({}, { abortRun })).rejects.toBe(error);
    expect(abortRun).toHaveBeenCalledTimes(1);
    expect(setActiveWait).toHaveBeenCalledTimes(2);
  });

  it("aborts if authorization changed before resuming", async () => {
    const abortRun = jest.fn();
    const error = new Error("entitlement changed");
    await expect(
      execute(
        {},
        {
          abortRun,
          revalidateAfterSuspend: async () => {
            throw error;
          },
        },
      ),
    ).rejects.toBe(error);
    expect(abortRun).toHaveBeenCalledTimes(1);
    expect(setActiveWait).toHaveBeenCalledTimes(2);
  });

  it("recovers a failed release so the same run can ask another question", async () => {
    let activeTool: string | undefined;
    let releaseFailed = false;
    setActiveWait.mockImplementation(async (input: any) => {
      if (input.tokenId) {
        if (activeTool) return "busy";
        activeTool = input.toolCallId;
        return "acquired";
      }
      expect(input).toMatchObject(contextToIdentity(input.toolCallId));
      if (!releaseFailed) {
        releaseFailed = true;
        throw new Error("temporary database failure");
      }
      if (activeTool !== input.toolCallId) return "stale";
      activeTool = undefined;
      return "released";
    });
    const abortRun = jest.fn();
    await expect(execute({}, { abortRun })).resolves.toMatchObject({
      success: true,
      reply: "Option A",
    });
    forToken.mockResolvedValue({
      ok: true,
      output: {
        ...contextToIdentity("tool-2"),
        replyId: "reply-2",
        text: "Confirmed",
      },
    });
    await expect(execute({}, { abortRun }, "tool-2")).resolves.toMatchObject({
      success: true,
      reply: "Confirmed",
    });
    expect(activeTool).toBeUndefined();
    expect(abortRun).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "aborts on persistent release failure without masking an existing error (%s)",
    async (alreadyFailed) => {
      const abortRun = jest.fn();
      const originalError = new Error("waitpoint unavailable");
      if (alreadyFailed) forToken.mockRejectedValue(originalError);
      setActiveWait
        .mockResolvedValueOnce("acquired")
        .mockRejectedValue(new Error("database unavailable"));
      const result = execute({}, { abortRun });
      if (alreadyFailed) await expect(result).rejects.toBe(originalError);
      else
        await expect(result).rejects.toThrow(
          "Could not release the Agent reply wait",
        );
      expect(abortRun).toHaveBeenCalled();
      const releases = setActiveWait.mock.calls.slice(1);
      expect(releases.length).toBeGreaterThan(1);
      expect(releases.length).toBeLessThanOrEqual(3);
      for (const [identity] of releases)
        expect(identity).toEqual(contextToIdentity("tool-1"));
    },
  );
});

// The product stop must wake only this invocation's token, wait for the
// original SDK waiter to settle, then surface the first stop reason.
describe("wait_for_user product stop", () => {
  const TOKEN_ID = "waitpoint_stop1";
  const CALLBACK_URL = `https://api.trigger.dev/api/v1/waitpoints/tokens/${TOKEN_ID}/callback/${"a1".repeat(32)}`;
  const reply = {
    ...contextToIdentity("tool-1"),
    replyId: "reply-1",
    text: "Option A",
  };
  type Completion = { ok: true; output: unknown } | { ok: false; error: Error };

  let stop: AbortController;
  let reason: Error;
  let fetchMock: jest.Mock<any>;
  let engine: ReturnType<typeof createEngine>;
  const originalFetch = globalThis.fetch;

  /**
   * One waitpoint token with the platform's contract: the first completion is
   * kept and later ones are no-ops; the waiting run learns the winner only
   * when notified, which may be later than any HTTP response.
   */
  function createEngine() {
    let winner: Completion | undefined;
    let notify!: (result: unknown) => void;
    let outputReads = 0;
    const wait = new Promise((resolve) => {
      notify = resolve;
    });
    return {
      wait,
      complete(result: Completion) {
        winner ??= result;
      },
      get winner() {
        return winner;
      },
      get outputReads() {
        return outputReads;
      },
      /** Deliver the winner like the SDK does, counting any output reads. */
      notify() {
        const settled = winner!;
        notify({
          ok: settled.ok,
          get output() {
            outputReads++;
            return settled.ok ? settled.output : undefined;
          },
          get error() {
            outputReads++;
            return settled.ok ? undefined : settled.error;
          },
        });
      },
    };
  }

  /** Let the tool reach its next await without relying on wall-clock time. */
  async function until(condition: () => boolean) {
    for (let turn = 0; turn < 100 && !condition(); turn++)
      await new Promise(setImmediate);
    expect(condition()).toBe(true);
  }

  async function turns(count = 10) {
    for (let turn = 0; turn < count; turn++) await new Promise(setImmediate);
  }

  function track<T>(promise: Promise<T>) {
    const state = { settled: false };
    promise.then(
      () => (state.settled = true),
      () => (state.settled = true),
    );
    return state;
  }

  const callbackBody = (init: any) =>
    JSON.parse(new TextDecoder().decode(init.body));

  beforeEach(() => {
    jest.resetAllMocks();
    stop = new AbortController();
    reason = new Error("local_connection_lost");
    engine = createEngine();
    createToken.mockResolvedValue({
      id: TOKEN_ID,
      isCached: false,
      url: CALLBACK_URL,
    });
    setActiveWait.mockResolvedValue("acquired");
    forToken.mockImplementation(() => engine.wait);
    // The callback endpoint commits a marker only if nothing completed first.
    fetchMock = jest.fn(async (_url: unknown, init: any) => {
      engine.complete({ ok: true, output: callbackBody(init) });
      return new Response(null, { status: 200 });
    });
    globalThis.fetch = fetchMock as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("does not create a token when the run already stopped", async () => {
    stop.abort(reason);
    await expect(execute({}, { signal: stop.signal })).rejects.toBe(reason);
    expect(createToken).not.toHaveBeenCalled();
    expect(setActiveWait).not.toHaveBeenCalled();
    expect(forToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["creating the token", "acquiring the slot", "preparing"])(
    "never parks when stopped while %s and releases an acquired slot",
    async (phase) => {
      const stopNow = () => stop.abort(reason);
      if (phase === "creating the token")
        createToken.mockImplementationOnce(async () => {
          stopNow();
          return { id: TOKEN_ID, isCached: false, url: CALLBACK_URL };
        });
      if (phase === "acquiring the slot")
        setActiveWait.mockImplementationOnce(async () => {
          stopNow();
          return "acquired";
        });
      const pauseActiveTime = jest.fn();
      await expect(
        execute(
          {},
          {
            signal: stop.signal,
            pauseActiveTime,
            ...(phase === "preparing"
              ? { beforeSuspend: async () => stopNow() }
              : {}),
          },
        ),
      ).rejects.toBe(reason);
      expect(forToken).not.toHaveBeenCalled();
      expect(pauseActiveTime).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(setActiveWait.mock.calls).toEqual(
        phase === "creating the token"
          ? []
          : [
              [{ ...contextToIdentity("tool-1"), tokenId: TOKEN_ID }],
              [contextToIdentity("tool-1")],
            ],
      );
    },
  );

  it("completes only this token on stop and throws the first reason after the original wait settles", async () => {
    const resumeActiveTime = jest.fn();
    const revalidateAfterSuspend = jest.fn<any>();
    const result = execute(
      {},
      { signal: stop.signal, resumeActiveTime, revalidateAfterSuspend },
    );
    const state = track(result);
    await until(() => forToken.mock.calls.length === 1);

    stop.abort(reason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toBe(CALLBACK_URL);
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(init.signal).not.toBe(stop.signal);
    expect(init.signal.aborted).toBe(false);
    expect(callbackBody(init)).toEqual({ type: "agent_wait_stopped" });

    // An accepted completion is not the run's wake-up: keep awaiting.
    await turns();
    expect(engine.winner).toEqual({
      ok: true,
      output: { type: "agent_wait_stopped" },
    });
    expect(state.settled).toBe(false);
    expect(resumeActiveTime).not.toHaveBeenCalled();

    engine.notify();
    await expect(result).rejects.toBe(reason);
    expect(engine.outputReads).toBe(0);
    expect(revalidateAfterSuspend).not.toHaveBeenCalled();
    expect(captureEvent).not.toHaveBeenCalledWith(
      "agent_wait_for_user_resumed",
      expect.anything(),
    );
    expect(resumeActiveTime).toHaveBeenCalledTimes(1);
    expect(setActiveWait).toHaveBeenLastCalledWith(contextToIdentity("tool-1"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a delivered reply", { ok: true, output: reply }, false],
    ["the wait timeout", { ok: false, error: new Error("timed out") }, false],
    ["a cached completed token", { ok: true, output: reply }, true],
  ] as const)(
    "keeps %s that completed first and still stops",
    async (_name, first, isCached) => {
      createToken.mockResolvedValue({
        id: TOKEN_ID,
        isCached,
        url: CALLBACK_URL,
      });
      const abortRun = jest.fn();
      const revalidateAfterSuspend = jest.fn<any>();
      const result = execute(
        {},
        { signal: stop.signal, abortRun, revalidateAfterSuspend },
      );
      await until(() => forToken.mock.calls.length === 1);
      engine.complete(first as Completion);

      stop.abort(reason);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      engine.notify();

      await expect(result).rejects.toBe(reason);
      expect(engine.winner).toBe(first);
      expect(engine.outputReads).toBe(0);
      expect(revalidateAfterSuspend).not.toHaveBeenCalled();
      expect(abortRun).not.toHaveBeenCalledWith("timed_out");
    },
  );

  it("completes the token when the stop fires while the wait registers", async () => {
    forToken.mockImplementation(() => {
      stop.abort(reason);
      return engine.wait;
    });
    const result = execute({}, { signal: stop.signal });
    await until(() => fetchMock.mock.calls.length === 1);
    engine.notify();
    await expect(result).rejects.toBe(reason);
    expect(engine.winner).toEqual({
      ok: true,
      output: { type: "agent_wait_stopped" },
    });
  });

  it("sends one completion however often the stop is signalled", async () => {
    const result = execute({}, { signal: stop.signal });
    await until(() => forToken.mock.calls.length === 1);
    stop.abort(reason);
    stop.abort(new Error("later"));
    stop.signal.dispatchEvent(new Event("abort"));
    await turns();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    engine.notify();
    await expect(result).rejects.toBe(reason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps awaiting the original wait when the callback is not this token's", async () => {
    createToken.mockResolvedValue({
      id: TOKEN_ID,
      isCached: false,
      url: CALLBACK_URL.replace(TOKEN_ID, "waitpoint_other"),
    });
    const result = execute({}, { signal: stop.signal });
    const state = track(result);
    await until(() => forToken.mock.calls.length === 1);
    stop.abort(reason);
    await turns();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.settled).toBe(false);

    // A real reply still settles the original waiter; the stop still wins.
    engine.complete({ ok: true, output: reply });
    engine.notify();
    await expect(result).rejects.toBe(reason);
    expect(engine.outputReads).toBe(0);
  });

  it("throws the first stop when the original wait rejects after it", async () => {
    let rejectWait!: (error: Error) => void;
    forToken.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectWait = reject;
        }),
    );
    const result = execute({}, { signal: stop.signal });
    await until(() => forToken.mock.calls.length === 1);
    stop.abort(reason);
    rejectWait(new Error("waitpoint unavailable"));
    await expect(result).rejects.toBe(reason);
  });

  it("aborts its own in-flight completion once the original wait settles", async () => {
    let requestSignal: AbortSignal | undefined;
    fetchMock.mockImplementation(
      (_url: unknown, init: any) =>
        new Promise((_resolve, reject) => {
          requestSignal = init.signal;
          init.signal.addEventListener("abort", () =>
            reject(new Error(`request to ${CALLBACK_URL} aborted`)),
          );
        }),
    );
    const result = execute({}, { signal: stop.signal });
    await until(() => forToken.mock.calls.length === 1);
    engine.complete({ ok: true, output: reply });
    stop.abort(reason);
    expect(requestSignal?.aborted).toBe(false);

    engine.notify();
    await expect(result).rejects.toBe(reason);
    expect(requestSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a reply", { ok: true, output: reply }, "message_arrived"],
    ["a timeout", { ok: false, error: new Error("timed out") }, "timed_out"],
  ] as const)(
    "returns %s normally and ignores a later stop",
    async (_name, first, outcome) => {
      const result = execute({}, { signal: stop.signal });
      await until(() => forToken.mock.calls.length === 1);
      engine.complete(first as Completion);
      engine.notify();
      await expect(result).resolves.toMatchObject({ wait_outcome: outcome });

      stop.abort(reason);
      await turns();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("preserves the first stop when releasing the slot keeps failing", async () => {
    setActiveWait
      .mockResolvedValueOnce("acquired")
      .mockRejectedValue(new Error("database unavailable"));
    const result = execute({}, { signal: stop.signal });
    await until(() => forToken.mock.calls.length === 1);
    stop.abort(reason);
    engine.notify();
    await expect(result).rejects.toBe(reason);
    expect(setActiveWait).toHaveBeenCalledTimes(4);
  });

  it("throws the first stop when it fires while revalidating a reply", async () => {
    const resumeActiveTime = jest.fn();
    const result = execute(
      {},
      {
        signal: stop.signal,
        resumeActiveTime,
        revalidateAfterSuspend: async () => {
          stop.abort(reason);
        },
      },
    );
    await until(() => forToken.mock.calls.length === 1);
    engine.complete({ ok: true, output: reply });
    engine.notify();
    await expect(result).rejects.toBe(reason);
    expect(captureEvent).not.toHaveBeenCalledWith(
      "agent_wait_for_user_resumed",
      expect.anything(),
    );
    // The original wait already settled and detached its stop listener.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(resumeActiveTime).toHaveBeenCalledTimes(1);
    expect(setActiveWait).toHaveBeenLastCalledWith(contextToIdentity("tool-1"));
  });

  it("never parks when pausing the runtime budget stops the run", async () => {
    const resumeActiveTime = jest.fn();
    await expect(
      execute(
        {},
        {
          signal: stop.signal,
          pauseActiveTime: () => stop.abort(reason),
          resumeActiveTime,
        },
      ),
    ).rejects.toBe(reason);
    expect(forToken).not.toHaveBeenCalled();
    expect(resumeActiveTime).toHaveBeenCalledTimes(1);
    expect(setActiveWait).toHaveBeenLastCalledWith(contextToIdentity("tool-1"));
  });

  // A failure that lands after the stop must not replace its reason.
  it.each([
    "creating the token",
    "acquiring the slot",
    "preparing",
    "revalidating",
  ])("keeps the first stop when %s fails after it", async (phase) => {
    const late = new Error(`late ${phase} failure`);
    const failAfterStop = async (): Promise<never> => {
      stop.abort(reason);
      throw late;
    };
    if (phase === "creating the token")
      createToken.mockImplementationOnce(failAfterStop);
    if (phase === "acquiring the slot")
      setActiveWait.mockImplementationOnce(failAfterStop);
    const result = execute(
      {},
      {
        signal: stop.signal,
        ...(phase === "preparing" ? { beforeSuspend: failAfterStop } : {}),
        ...(phase === "revalidating"
          ? { revalidateAfterSuspend: failAfterStop }
          : {}),
      },
    );
    if (phase === "revalidating") {
      await until(() => forToken.mock.calls.length === 1);
      engine.complete({ ok: true, output: reply });
      engine.notify();
    }
    await expect(result).rejects.toBe(reason);
    expect(setActiveWait.mock.calls.length).toBe(
      phase === "creating the token" || phase === "acquiring the slot"
        ? Number(phase === "acquiring the slot")
        : 2,
    );
  });

  it.each(["busy", "stale"])(
    "throws the first stop instead of reporting a %s slot acquired after it",
    async (outcome) => {
      setActiveWait.mockImplementationOnce(async () => {
        stop.abort(reason);
        return outcome;
      });
      await expect(execute({}, { signal: stop.signal })).rejects.toBe(reason);
      expect(setActiveWait).toHaveBeenCalledTimes(1);
      expect(forToken).not.toHaveBeenCalled();
    },
  );

  it.each(["creating the token", "the wait"])(
    "still reports an unstopped failure while %s unchanged",
    async (phase) => {
      const error = new Error(`${phase} unavailable`);
      if (phase === "creating the token") createToken.mockRejectedValue(error);
      else forToken.mockRejectedValue(error);
      // As in agent-long, the tool's own failure aborts the same stop signal;
      // that must not turn the original error into an abort.
      const abortRun = jest.fn(() => stop.abort());
      await expect(execute({}, { signal: stop.signal, abortRun })).rejects.toBe(
        error,
      );
    },
  );

  it("throws a stop that arrives while releasing the slot after a reply", async () => {
    setActiveWait
      .mockResolvedValueOnce("acquired")
      .mockImplementationOnce(async () => {
        stop.abort(reason);
        return "released";
      });
    const result = execute({}, { signal: stop.signal });
    await until(() => forToken.mock.calls.length === 1);
    engine.complete({ ok: true, output: reply });
    engine.notify();
    await expect(result).rejects.toBe(reason);
    expect(setActiveWait).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws a stop that arrives while every release retry fails after a reply", async () => {
    const abortRun = jest.fn();
    const unavailable = new Error("database unavailable");
    setActiveWait
      .mockResolvedValueOnce("acquired")
      .mockImplementationOnce(async () => {
        stop.abort(reason);
        throw unavailable;
      })
      .mockRejectedValue(unavailable);
    const result = execute({}, { signal: stop.signal, abortRun });
    await until(() => forToken.mock.calls.length === 1);
    engine.complete({ ok: true, output: reply });
    engine.notify();
    await expect(result).rejects.toBe(reason);
    // The existing three fenced release attempts still run.
    expect(setActiveWait.mock.calls.slice(1)).toEqual(
      Array(3).fill([contextToIdentity("tool-1")]),
    );
    expect(abortRun).not.toHaveBeenCalled();
  });

  it("still returns a timeout whose own abort lands before the release", async () => {
    // As in agent-long, reporting the timeout aborts the same stop signal.
    const abortRun = jest.fn((_outcome: string) =>
      stop.abort("wait_for_user_timeout"),
    );
    const result = execute({}, { signal: stop.signal, abortRun });
    await until(() => forToken.mock.calls.length === 1);
    engine.complete({ ok: false, error: new Error("timed out") });
    engine.notify();
    await expect(result).resolves.toMatchObject({ wait_outcome: "timed_out" });
    expect(abortRun).toHaveBeenCalledWith("timed_out");
  });
});

function contextToIdentity(toolCallId: string) {
  return {
    chatId: context.chatId,
    userId: context.userID,
    runId: context.triggerRunId,
    toolCallId,
  };
}
