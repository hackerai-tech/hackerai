/** @jest-environment node */
import type { AnySandbox } from "@/types";
import { getFunctionName } from "convex/server";
import { BrowserSessions } from "../browser-sessions";
import { getConvexClient } from "@/lib/db/convex-client";
import { phLogger } from "@/lib/posthog/server";
import { createAgentStopSignal } from "@/lib/chat/agent-stop-signal";
import {
  BrowserHandoffAbandonedError,
  manualAgentResumeFinishReason,
} from "@/lib/chat/manual-agent-resume";
import * as handoffs from "@/convex/browserHandoffs";

jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: jest.fn(),
}));
jest.mock("@/lib/posthog/server", () => ({
  phLogger: { info: jest.fn() },
}));
// The real handoff handlers run in-process against an in-memory store.
jest.mock("@/convex/lib/serviceFunctions", () => ({
  mutation: (config: unknown) => config,
  query: (config: unknown) => config,
}));
jest.mock("@/convex/lib/utils", () => ({
  validateServiceKey: () => undefined,
}));

function sandbox() {
  return {
    sandboxId: "test-sandbox",
    commands: { run: jest.fn(async () => ({ exitCode: 0 })) },
  };
}

describe("browser preparation attribution", () => {
  const scope = {
    userId: "opaque-user",
    chatId: "opaque-chat",
    runId: "run_opaque",
    agentId: "agent_opaque",
    serviceKey: "PRIVATE_SERVICE_KEY",
  };
  let mutation: jest.Mock;
  beforeEach(() => {
    jest.clearAllMocks();
    mutation = jest.fn(async () => true);
    jest.mocked(getConvexClient).mockReturnValue({ mutation } as never);
  });

  it.each([
    "gate_only",
    "recognized_browser_command",
    "interactive_shell",
    "internal",
  ] as const)(
    "retains the first %s reason across concurrent reuse",
    async (reason) => {
      const target = sandbox();
      target.commands.run.mockImplementation(async () => ({
        exitCode: 0,
        stdout: "/usr/bin",
      }));
      const owner = new BrowserSessions(scope);
      const [first, reused] = await Promise.all([
        owner.prepare(target as unknown as AnySandbox, reason),
        owner.prepare(
          target as unknown as AnySandbox,
          "recognized_browser_command",
        ),
      ]);
      expect(first).toEqual(reused);
      expect(phLogger.info).toHaveBeenCalledTimes(1);
      expect(phLogger.info).toHaveBeenCalledWith(
        "browser_session_preparation_diagnostics",
        {
          diagnostic_version: 1,
          observation_scope: "initial_registered_root",
          preparation_reason: reason,
          browser_session_id: expect.stringMatching(/^[a-f0-9]{32}$/),
          trigger_run_id: "run_opaque",
          agent_id: "agent_opaque",
        },
      );
      expect(target.commands.run).toHaveBeenCalledTimes(1);
      await owner.cleanup();
    },
  );

  it("reports only after successful registration without replacing the creation reason", async () => {
    const target = sandbox();
    target.commands.run.mockImplementation(async () => ({
      exitCode: 0,
      stdout: "/usr/bin",
    }));
    mutation.mockResolvedValueOnce(false);
    const owner = new BrowserSessions(scope);
    await owner.prepare(target as unknown as AnySandbox, "gate_only");
    expect(phLogger.info).not.toHaveBeenCalled();
    await owner.prepare(
      target as unknown as AnySandbox,
      "recognized_browser_command",
    );
    expect(phLogger.info).toHaveBeenCalledWith(
      "browser_session_preparation_diagnostics",
      expect.objectContaining({ preparation_reason: "gate_only" }),
    );
    expect(target.commands.run).toHaveBeenCalledTimes(1);
    await owner.cleanup();
  });

  it("cannot leak arbitrary reasons or scope contents, and delivery failure leaves setup usable", async () => {
    const target = sandbox();
    target.commands.run.mockImplementation(async () => ({
      exitCode: 0,
      stdout: "/usr/bin",
    }));
    const owner = new BrowserSessions({
      ...scope,
      runId: "PRIVATE_SERVICE_KEY",
      agentId: "https://private.example",
    });
    jest.mocked(phLogger.info).mockImplementationOnce(() => {
      throw new Error("sink unavailable");
    });
    const env = await owner.prepare(
      target as unknown as AnySandbox,
      "https://private.example" as never,
    );
    expect(env.AGENT_BROWSER_SOCKET_DIR).toMatch(
      /^\/dev\/shm\/hackerai-browser-/,
    );
    expect(phLogger.info).toHaveBeenCalledWith(
      "browser_session_preparation_diagnostics",
      expect.objectContaining({
        preparation_reason: "internal",
        trigger_run_id: "unknown",
        agent_id: "unknown",
      }),
    );
    await owner.prepare(target as unknown as AnySandbox);
    expect(phLogger.info).toHaveBeenCalledTimes(1);
    await owner.cleanup();
  });
});

describe("managed browser ownership", () => {
  it("isolates parent, sibling, and later-run sockets and encryption keys", async () => {
    const target = sandbox();
    const owners = [
      new BrowserSessions(),
      new BrowserSessions(),
      new BrowserSessions(),
    ];
    const envs = await Promise.all(
      owners.map((owner) => owner.prepare(target as unknown as AnySandbox)),
    );
    expect(new Set(envs.map((env) => env.AGENT_BROWSER_SOCKET_DIR)).size).toBe(
      3,
    );
    expect(
      new Set(envs.map((env) => env.AGENT_BROWSER_ENCRYPTION_KEY)).size,
    ).toBe(3);
    for (const env of envs) {
      expect(env.AGENT_BROWSER_SOCKET_DIR.length).toBeLessThan(85);
      expect(env.AGENT_BROWSER_ENCRYPTION_KEY).toMatch(/^[a-f0-9]{64}$/);
      expect(env.AGENT_BROWSER_SESSION_NAME).toBeUndefined();
      expect(env.HOME).toBeUndefined();
      expect(target.commands.run.mock.calls.flat().join(" ")).not.toContain(
        env.AGENT_BROWSER_ENCRYPTION_KEY,
      );
    }
    await Promise.all(owners.map((owner) => owner.cleanup()));
  });

  it("shares preparation across simultaneous calls but rejects commands after cleanup", async () => {
    const target = sandbox();
    const owner = new BrowserSessions();
    const [a, b] = await Promise.all([
      owner.prepare(target as unknown as AnySandbox),
      owner.prepare(target as unknown as AnySandbox),
    ]);
    expect(a).toEqual(b);
    expect(target.commands.run).toHaveBeenCalledTimes(1);
    await Promise.all([owner.cleanup(), owner.cleanup()]);
    expect(target.commands.run).toHaveBeenCalledTimes(2);
    await expect(
      owner.prepare(target as unknown as AnySandbox),
    ).rejects.toThrow("ownership has ended");
  });

  it("keeps the same browser namespace when the sandbox transport reconnects", async () => {
    const owner = new BrowserSessions();
    const first = sandbox();
    const reconnect = sandbox();
    const initial = await owner.prepare(first as unknown as AnySandbox);
    expect(await owner.prepare(reconnect as unknown as AnySandbox)).toEqual(
      initial,
    );
    expect(reconnect.commands.run).not.toHaveBeenCalled();
    await owner.cleanup();
    expect(reconnect.commands.run).toHaveBeenCalledTimes(1);
  });

  it("waits for in-flight setup when cancellation wins", async () => {
    let finish!: () => void;
    const target = sandbox();
    target.commands.run.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ exitCode: 0 });
        }),
    );
    const owner = new BrowserSessions();
    const preparation = owner.prepare(target as unknown as AnySandbox);
    const rejected = expect(preparation).rejects.toThrow("ownership has ended");
    const cleanup = owner.cleanup();
    finish();
    await rejected;
    await cleanup;
    expect(target.commands.run).toHaveBeenCalledTimes(2);
  });

  it("fails closed if setup fails, still attempting cleanup", async () => {
    const target = sandbox();
    target.commands.run.mockRejectedValueOnce(new Error("unavailable"));
    const owner = new BrowserSessions();
    await expect(
      owner.prepare(target as unknown as AnySandbox),
    ).rejects.toThrow("unavailable");
    await owner.cleanup();
    expect(target.commands.run).toHaveBeenCalledTimes(2);
  });

  it("does not create directories or authentication files on connected hosts", async () => {
    const target = { ...sandbox(), sandboxKind: "centrifugo" };
    const owner = new BrowserSessions();
    expect(await owner.prepare(target as unknown as AnySandbox)).toEqual({});
    await owner.cleanup();
    expect(target.commands.run).not.toHaveBeenCalled();
  });

  it.each(["rejection", "nonzero exit"])(
    "retries after a %s and cleans up both attempted directories",
    async (failure) => {
      const target = sandbox();
      if (failure === "rejection") {
        target.commands.run.mockRejectedValueOnce(new Error("unavailable"));
      } else {
        target.commands.run.mockResolvedValueOnce({ exitCode: 1 });
      }
      const owner = new BrowserSessions();
      const attempts = await Promise.allSettled([
        owner.prepare(target as unknown as AnySandbox),
        owner.prepare(target as unknown as AnySandbox),
      ]);
      expect(attempts.map((attempt) => attempt.status)).toEqual([
        "rejected",
        "rejected",
      ]);
      expect(target.commands.run).toHaveBeenCalledTimes(1);
      const failedDirectory = target.commands.run.mock.calls
        .flat()
        .join(" ")
        .match(/\/dev\/shm\/hackerai-browser-[a-f0-9]+/)?.[0];
      expect(failedDirectory).toBeDefined();

      const recovered = await owner.prepare(target as unknown as AnySandbox);
      expect(recovered.AGENT_BROWSER_SOCKET_DIR).not.toContain(failedDirectory);
      expect(await owner.prepare(target as unknown as AnySandbox)).toEqual(
        recovered,
      );
      expect(target.commands.run).toHaveBeenCalledTimes(2);
      await owner.cleanup();
      expect(target.commands.run).toHaveBeenCalledTimes(4);
      const cleanupCommands = target.commands.run.mock.calls
        .slice(2)
        .flat()
        .join(" ");
      expect(cleanupCommands).toContain(failedDirectory);
      expect(cleanupCommands).toContain(
        recovered.AGENT_BROWSER_SOCKET_DIR.replace(/\/sockets$/, ""),
      );
    },
  );
});

describe("abandoned parent browser handoff", () => {
  const MINUTES_30 = 30 * 60_000;
  type Row = Record<string, unknown> & { _id: string };
  type Handler = { handler: (ctx: unknown, args: unknown) => Promise<unknown> };

  /** The real handoff handlers over an in-memory store; one call = one transaction. */
  function backend() {
    const rows: Record<string, Row[]> = {
      chats: [
        {
          _id: "chat-row",
          id: "chat",
          user_id: "owner",
          active_trigger_run_id: "run",
        },
      ],
      subagent_runs: [],
      browser_handoffs: [],
      agent_goals: [],
      messages: [],
    };
    const ctx = {
      db: {
        query: (table: string) => ({
          withIndex: (
            _index: string,
            select: (q: { eq: (f: string, v: unknown) => unknown }) => unknown,
          ) => {
            const equals: Record<string, unknown> = {};
            const q = {
              eq(field: string, value: unknown) {
                equals[field] = value;
                return q;
              },
            };
            select(q);
            const selected = () =>
              rows[table].filter((row) =>
                Object.entries(equals).every(([f, v]) => row[f] === v),
              );
            return {
              first: async () => selected()[0] ?? null,
              order: () => ({
                first: async () => selected().at(-1) ?? null,
                take: async (n: number) => selected().slice(-n).reverse(),
              }),
            };
          },
        }),
        insert: async (table: string, value: Record<string, unknown>) => {
          rows[table].push({ _id: `${table}-${rows[table].length}`, ...value });
        },
        patch: async (id: string, value: Record<string, unknown>) => {
          Object.assign(
            Object.values(rows)
              .flat()
              .find((row) => row._id === id)!,
            value,
          );
        },
      },
    };
    const run = (name: string, args: Record<string, unknown>) =>
      (handoffs as unknown as Record<string, Handler>)[name].handler(ctx, args);
    /** Lets a test commit a competing transaction or lose a response. */
    const intercept: Record<
      string,
      (commit: () => Promise<unknown>) => Promise<unknown>
    > = {};
    const call = (ref: unknown, args: Record<string, unknown>) => {
      const name = getFunctionName(ref as never).split(":")[1];
      return intercept[name]
        ? intercept[name](() => run(name, args))
        : run(name, args);
    };
    const mutation = jest.fn(call);
    jest
      .mocked(getConvexClient)
      .mockReturnValue({ query: jest.fn(call), mutation } as never);
    const row = () => rows.browser_handoffs.at(-1)!;
    /** A user's browser action on the current row, as the viewer route sends it. */
    const user = (name: string, extra: Record<string, unknown> = {}) =>
      run(name, {
        serviceKey: "key",
        userId: "owner",
        sessionId: row().session_id,
        ...extra,
      });
    const closeCalls = () =>
      mutation.mock.calls.filter(
        ([ref]) =>
          getFunctionName(ref as never) === "browserHandoffs:abandonForBackend",
      ).length;
    return { rows, row, user, intercept, closeCalls };
  }

  async function parentRun({ abandonable = true } = {}) {
    const store = backend();
    const stop = createAgentStopSignal({
      onAbort: () => {},
      getStreamState: () => undefined,
    });
    // As the Trigger worker wires them: the first stop wins.
    const lost = jest.fn(() => stop.abort("browser_ownership_lost"));
    const abandoned = jest.fn(() =>
      stop.abort(
        "browser_handoff_abandoned",
        new BrowserHandoffAbandonedError(),
      ),
    );
    const owner = new BrowserSessions(
      {
        userId: "owner",
        chatId: "chat",
        runId: "run",
        agentId: "parent",
        serviceKey: "key",
      },
      lost,
      abandonable ? abandoned : undefined,
    );
    const target = {
      sandboxId: "synthetic-sandbox",
      commands: {
        run: jest.fn(async () => ({ exitCode: 0, stdout: "/usr/bin" })),
      },
    } as unknown as AnySandbox;
    await owner.prepare(target);
    expect(store.row().state).toBe("agent");
    const requestWait = () =>
      store.user("requestWaitForBackend", {
        expectedUpdatedAt: store.row().updated_at,
      });
    const gate = () =>
      observe(owner.waitForAgentControl(stop.controller.signal));
    const finish = async () => {
      stop.controller.abort();
      await jest.advanceTimersByTimeAsync(1_000);
      await owner.cleanup();
    };
    return {
      ...store,
      stop,
      lost,
      abandoned,
      owner,
      target,
      requestWait,
      gate,
      finish,
    };
  }

  function observe(promise: Promise<unknown>) {
    const outcome: { done: boolean; value?: unknown; error?: unknown } = {
      done: false,
    };
    promise.then(
      (value) => Object.assign(outcome, { done: true, value }),
      (error) => Object.assign(outcome, { done: true, error }),
    );
    return outcome;
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(1_800_000_000_000);
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("stops every waiting gate as abandoned at the deadline, with one fenced close", async () => {
    const run = await parentRun();
    expect(await run.requestWait()).toBe(true);
    const model = run.gate();
    const tool = run.gate();

    await jest.advanceTimersByTimeAsync(MINUTES_30 - 2_000);
    expect(model.done).toBe(false);
    expect(run.closeCalls()).toBe(0);
    expect(run.row().state).toBe("waiting");

    await jest.advanceTimersByTimeAsync(4_000);
    for (const gate of [model, tool]) {
      expect(gate.done).toBe(true);
      expect(gate.error).toBeInstanceOf(BrowserHandoffAbandonedError);
    }
    expect(run.lost).not.toHaveBeenCalled();
    expect(run.stop.source).toBe("browser_handoff_abandoned");
    expect(
      manualAgentResumeFinishReason(run.stop.controller.signal.reason),
    ).toBe("browser-handoff-abandoned");
    expect(run.closeCalls()).toBe(1);
    expect(run.row()).toMatchObject({
      state: "closed",
      abandoned_at: expect.any(Number),
    });
    // The user can no longer take over or resume this run's browser.
    expect(
      await run.user("beginTakeoverForBackend", { grant: "g".repeat(32) }),
    ).toBe(false);
    expect(await run.user("beginResumeForBackend")).toBe(false);
    // Later gates stop the same way; no new browser work is admitted.
    await expect(run.owner.waitForAgentControl()).rejects.toBeInstanceOf(
      BrowserHandoffAbandonedError,
    );
    await expect(run.owner.prepare(run.target)).rejects.toThrow(
      "ownership has ended",
    );
    await run.finish();
  });

  it("holds the run while a human grant is renewed, then measures from its expiry", async () => {
    const run = await parentRun();
    await run.requestWait();
    const gate = run.gate();
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    const grant = "g".repeat(32);
    expect(await run.user("beginTakeoverForBackend", { grant })).toBe(true);
    expect(
      await run.user("finishTakeoverForBackend", {
        grant,
        browserSessionName: "default",
      }),
    ).toBe(true);
    // Active control well past the original waiting deadline.
    for (let elapsed = 0; elapsed < 40 * 60_000; elapsed += 20_000) {
      await jest.advanceTimersByTimeAsync(20_000);
      expect(
        await run.user("assertGrantForBackend", { grant, renew: true }),
      ).toBe(true);
    }
    expect(gate.done).toBe(false);
    expect(run.closeCalls()).toBe(0);

    // The viewer goes away. The run stays paused for an explicit return.
    const expiry = run.row().grant_expires_at as number;
    await jest.advanceTimersByTimeAsync(
      expiry + MINUTES_30 - Date.now() - 2_000,
    );
    expect(gate.done).toBe(false);
    expect(run.closeCalls()).toBe(0);
    expect(run.row().state).toBe("human");

    await jest.advanceTimersByTimeAsync(4_000);
    expect(gate.error).toBeInstanceOf(BrowserHandoffAbandonedError);
    expect(run.row().abandoned_at).toBeGreaterThanOrEqual(expiry + MINUTES_30);
    await run.finish();
  });

  it("lets a resume that commits first win, and the run continues", async () => {
    const run = await parentRun();
    const grant = "g".repeat(32);
    await run.user("beginTakeoverForBackend", { grant });
    await run.user("finishTakeoverForBackend", {
      grant,
      browserSessionName: "default",
    });
    await run.user("releaseForBackend", { grant });
    expect(run.row().state).toBe("recovery");
    const gate = run.gate();
    // The user's Resume transaction lands just before the worker's close.
    run.intercept.abandonForBackend = async (commit) => {
      delete run.intercept.abandonForBackend;
      expect(await run.user("beginResumeForBackend")).toBe(true);
      return commit();
    };
    await jest.advanceTimersByTimeAsync(MINUTES_30 + 2_000);
    expect(run.closeCalls()).toBe(1);
    expect(run.row()).toMatchObject({ state: "resuming" });
    expect(run.row().abandoned_at).toBeUndefined();
    expect(gate.done).toBe(false);

    expect(await run.user("finishResumeForBackend")).toBe(true);
    await jest.advanceTimersByTimeAsync(2_000);
    expect(gate).toEqual({ done: true, value: true });
    expect(run.abandoned).not.toHaveBeenCalled();
    expect(run.stop.controller.signal.aborted).toBe(false);
    await run.finish();
  });

  it("recovers a lost close response from the committed receipt without closing twice", async () => {
    const run = await parentRun();
    await run.requestWait();
    const gate = run.gate();
    let committedAt: unknown;
    run.intercept.abandonForBackend = async (commit) => {
      delete run.intercept.abandonForBackend;
      expect(await commit()).toBe("abandoned");
      committedAt = run.row().abandoned_at;
      throw new TypeError("fetch failed");
    };
    await jest.advanceTimersByTimeAsync(MINUTES_30 + 2_000);
    expect(gate.error).toBeInstanceOf(BrowserHandoffAbandonedError);
    expect(run.lost).not.toHaveBeenCalled();
    expect(run.closeCalls()).toBe(2);
    expect(run.row().abandoned_at).toBe(committedAt);
    await run.finish();
  });

  it("stays parked while a committed abandonment receipt is unavailable across retry batches", async () => {
    const run = await parentRun();
    await run.requestWait();
    const gate = run.gate();
    let attempts = 0;
    run.intercept.abandonForBackend = async (commit) => {
      const result = await commit();
      if (++attempts <= 6) throw new TypeError("fetch failed");
      return result;
    };

    await jest.advanceTimersByTimeAsync(MINUTES_30 + 2_000);
    expect(run.row().state).toBe("closed");
    expect(run.closeCalls()).toBe(6);
    expect(gate.done).toBe(false);
    expect(run.lost).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(5_000);
    expect(gate.error).toBeInstanceOf(BrowserHandoffAbandonedError);
    expect(run.closeCalls()).toBe(7);
    expect(run.lost).not.toHaveBeenCalled();
    await run.finish();
  });

  it("reports a close another gate observes before its response as abandonment, not ownership loss", async () => {
    const run = await parentRun();
    await run.requestWait();
    const first = run.gate();
    let respond!: () => void;
    let late: ReturnType<typeof observe> | undefined;
    run.intercept.abandonForBackend = async (commit) => {
      const result = await commit();
      // A gate that starts now reads the closed row before this response.
      late = run.gate();
      await new Promise<void>((resolve) => {
        respond = resolve;
      });
      return result;
    };
    await jest.advanceTimersByTimeAsync(MINUTES_30 + 2_000);
    expect(late?.done).toBe(false);
    expect(first.done).toBe(false);
    respond();
    await jest.advanceTimersByTimeAsync(0);
    expect(late?.error).toBeInstanceOf(BrowserHandoffAbandonedError);
    expect(first.error).toBeInstanceOf(BrowserHandoffAbandonedError);
    expect(run.lost).not.toHaveBeenCalled();
    expect(run.stop.source).toBe("browser_handoff_abandoned");
    await run.finish();
  });

  it("keeps the ownership-loss reason when the run is replaced while waiting", async () => {
    const run = await parentRun();
    await run.requestWait();
    const gate = run.gate();
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    run.rows.chats[0].active_trigger_run_id = "replacement";
    await jest.advanceTimersByTimeAsync(2_000);
    expect(gate.done).toBe(true);
    expect(run.stop.source).toBe("browser_ownership_lost");
    expect(run.abandoned).not.toHaveBeenCalled();
    expect(run.closeCalls()).toBe(0);
    await run.finish();
  });

  it.each([
    ["an older backend omits the deadline", true],
    ["the owner has no abandonment stop (Ask or child)", false],
  ])("keeps holding the run when %s", async (name, abandonable) => {
    const run = await parentRun({ abandonable });
    if (abandonable) {
      const query = jest.mocked(getConvexClient)().query as jest.Mock;
      const current = query.getMockImplementation()!;
      query.mockImplementation(async (...args: unknown[]) => {
        const state = (await current(...args)) as Record<
          string,
          unknown
        > | null;
        if (state) delete state.abandonAfter;
        return state;
      });
    }
    await run.requestWait();
    const gate = run.gate();
    await jest.advanceTimersByTimeAsync(MINUTES_30 + 60_000);
    expect(gate.done).toBe(false);
    expect(run.closeCalls()).toBe(0);
    expect(run.row().state).toBe("waiting");
    await run.finish();
  });
});
