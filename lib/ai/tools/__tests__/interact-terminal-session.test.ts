/**
 * Tests for `interact_terminal_session` — interactive PTY session actions:
 * send, wait, view, kill.
 *
 * Session creation is tested in run-terminal-cmd.test.ts. Here we verify:
 *  - the dispatch contract for {send, wait, view, kill}
 *  - input size cap
 *  - pty-keys decoding (Enter / C-c / plain text)
 *  - wait policy (pattern + idle)
 *  - ANSI stripping + bufferTruncated surfacing
 *  - structured errors for missing sessions
 */

// Stub out @e2b/code-interpreter — its ESM `chalk` dependency trips Jest's
// default transformer. We only need the named exports that appear in
// the PTY adapter to be importable.
jest.mock("@e2b/code-interpreter", () => ({
  CommandExitError: class CommandExitError extends Error {
    exitCode: number;
    constructor(msg = "exit", exitCode = 1) {
      super(msg);
      this.exitCode = exitCode;
    }
  },
  Sandbox: class {},
}));

// Same for the caido-proxy and proxy-manager imports that would drag in
// Convex/network deps during this unit test.
jest.mock("../utils/caido-proxy", () => ({
  getCaidoConfig: () => ({}),
  buildCaidoProxyEnvVars: () => undefined,
}));
jest.mock("../utils/proxy-manager", () => ({
  ensureCaido: async () => undefined,
}));

import { createInteractTerminalSession } from "../interact-terminal-session";
import { createRunTerminalCmd } from "../run-terminal-cmd";
import type { PtyHandle } from "../utils/e2b-pty-adapter";
import {
  PtySessionManager,
  MAX_CONCURRENT_PTYS_PER_CHAT,
} from "../utils/pty-session-manager";

// ── Mock hybrid-sandbox-manager so we can return a fake sandbox ──────
jest.mock("../utils/e2b-pty-adapter", () => {
  const actual = jest.requireActual("../utils/e2b-pty-adapter");
  return {
    ...actual,
    // Overridden per test by assigning to `mockCreateHandle`
    createE2BPtyHandle: jest.fn(),
  };
});

import { createE2BPtyHandle } from "../utils/e2b-pty-adapter";
const mockCreateE2BPtyHandle = createE2BPtyHandle as jest.MockedFunction<
  typeof createE2BPtyHandle
>;

jest.mock("../utils/centrifugo-pty-adapter", () => ({
  createCentrifugoPtyHandle: jest.fn(),
}));

// ── Fake PTY handle factory ──────────────────────────────────────────

interface FakeHandle extends PtyHandle {
  emit: (bytes: Uint8Array) => void;
  sendInputCalls: Uint8Array[];
  killed: boolean;
  resolveExit: (code: number | null) => void;
}

function makeFakeHandle(pid = 4242): FakeHandle {
  const listeners = new Set<(bytes: Uint8Array) => void>();
  let resolveExit: (v: { exitCode: number | null }) => void;
  const exited = new Promise<{ exitCode: number | null }>((r) => {
    resolveExit = r;
  });
  const sendInputCalls: Uint8Array[] = [];

  const handle: FakeHandle = {
    pid,
    sendInput: jest.fn(async (bytes: Uint8Array) => {
      sendInputCalls.push(new Uint8Array(bytes));
    }) as unknown as PtyHandle["sendInput"],
    resize: jest.fn(async () => undefined) as unknown as PtyHandle["resize"],
    kill: jest.fn(async () => {
      handle.killed = true;
      resolveExit({ exitCode: 0 });
    }) as unknown as PtyHandle["kill"],
    onData: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    exited,
    // instrumentation
    emit: (bytes: Uint8Array) => {
      for (const l of Array.from(listeners)) l(bytes);
    },
    sendInputCalls,
    killed: false,
    resolveExit: (code: number | null) => resolveExit({ exitCode: code }),
  };
  return handle;
}

// ── Fake sandbox that passes isE2BSandbox (has `jupyterUrl`) ─────────

function makeFakeE2BSandbox() {
  return {
    jupyterUrl: "http://fake",
    commands: { run: jest.fn() },
  };
}

// ── Context factory ──────────────────────────────────────────────────

function makeContext(opts: {
  sandbox: unknown | null;
  ptySessionManager?: PtySessionManager;
  chatId?: string;
}) {
  const writerWrites: unknown[] = [];
  const writer = {
    write: (p: unknown) => {
      writerWrites.push(p);
    },
  } as unknown as import("ai").UIMessageStreamWriter;

  const sandboxManager = {
    getSandbox: jest.fn(async () => ({ sandbox: opts.sandbox })),
    setSandbox: jest.fn(),
    getSandboxType: jest.fn(),
    getSandboxInfo: jest.fn(() => null),
    getEffectivePreference: jest.fn(() => "e2b"),
    recordHealthFailure: jest.fn(() => false),
    resetHealthFailures: jest.fn(),
    isSandboxUnavailable: jest.fn(() => false),
    consumeFallbackInfo: jest.fn(() => null),
  };

  const ptySessionManager = opts.ptySessionManager ?? new PtySessionManager();

  const context = {
    sandboxManager,
    writer,
    userLocation: {} as never,
    todoManager: {} as never,
    userID: "u1",
    chatId: opts.chatId ?? "chat-1",
    fileAccumulator: {} as never,
    backgroundProcessTracker: {} as never,
    ptySessionManager,
    mode: "agent",
    isE2BSandbox: (s: unknown) => {
      if (!s || typeof s !== "object") return false;
      if ((s as { sandboxKind?: unknown }).sandboxKind === "centrifugo")
        return false;
      const sb = s as { jupyterUrl?: unknown; pty?: unknown };
      return typeof sb.jupyterUrl === "string" || typeof sb.pty === "object";
    },
    guardrailsConfig: undefined,
    caidoEnabled: false,
  } as unknown as import("@/types").ToolContext;

  return { context, writerWrites, sandboxManager, ptySessionManager };
}

// Helper: invoke the tool.execute with given args/options.
async function runTool(
  tool: ReturnType<typeof createInteractTerminalSession>,
  input: Record<string, unknown>,
) {
  const execute = (
    tool as unknown as {
      execute: (i: unknown, o: unknown) => Promise<unknown>;
    }
  ).execute;
  return execute(input, {
    toolCallId: "call-1",
    abortSignal: undefined,
    messages: [],
  });
}

// Helper: invoke run_terminal_cmd to create a session
async function runExecTool(
  tool: ReturnType<typeof createRunTerminalCmd>,
  input: Record<string, unknown>,
) {
  const execute = (
    tool as unknown as {
      execute: (i: unknown, o: unknown) => Promise<unknown>;
    }
  ).execute;
  return execute(input, {
    toolCallId: "call-1",
    abortSignal: undefined,
    messages: [],
  });
}

// Helper: create a session using run_terminal_cmd
async function createSession(
  context: import("@/types").ToolContext,
  handle: FakeHandle,
): Promise<string> {
  mockCreateE2BPtyHandle.mockImplementation(async () => handle);
  const execTool = createRunTerminalCmd(context);
  const execP = runExecTool(execTool, {
    action: "exec",
    command: "sh",
    explanation: "x",
    is_background: false,
    interactive: true,
    wait_for: { idle_ms: 5, timeout_ms: 200 },
  });
  await new Promise((r) => setTimeout(r, 0));
  const created = (await execP) as { result: { session: string } };
  return created.result.session;
}

describe("interact_terminal_session — PTY action dispatch", () => {
  beforeEach(() => {
    mockCreateE2BPtyHandle.mockReset();
  });

  test("send on unknown session returns structured error", async () => {
    const { context } = makeContext({ sandbox: makeFakeE2BSandbox() });
    const tool = createInteractTerminalSession(context);
    const result = (await runTool(tool, {
      action: "send",
      session: "nope",
      input: "hi\n",
    })) as { result: { error?: string } };
    expect(result.result.error).toMatch(/Session nope not found/);
  });

  test("send with oversized input errors without calling sendInput", async () => {
    const e2b = makeFakeE2BSandbox();
    const handle = makeFakeHandle();

    const { context } = makeContext({ sandbox: e2b });
    const sessionId = await createSession(context, handle);

    // Count of sendInput calls so far (1 — the initial command).
    const before = handle.sendInputCalls.length;

    const tool = createInteractTerminalSession(context);
    const huge = "a".repeat(8 * 1024 + 1);
    const result = (await runTool(tool, {
      action: "send",
      session: sessionId,
      input: huge,
    })) as { result: { error?: string } };

    expect(result.result.error).toMatch(/exceeds MAX_INPUT_BYTES_PER_SEND/);
    expect(handle.sendInputCalls.length).toBe(before);
  });

  test("send passes raw escape sequences directly: \\x03 for Ctrl+C, \\n for Enter, plain text verbatim", async () => {
    const e2b = makeFakeE2BSandbox();
    const handle = makeFakeHandle();

    const { context } = makeContext({ sandbox: e2b });
    const sessionId = await createSession(context, handle);

    const tool = createInteractTerminalSession(context);

    const sendAndGet = async (input: string) => {
      const beforeLen = handle.sendInputCalls.length;
      void runTool(tool, {
        action: "send",
        session: sessionId,
        input,
        wait_for: { idle_ms: 10, timeout_ms: 200 },
      });
      // Yield so the tool's awaited sendInput runs.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      return handle.sendInputCalls[beforeLen];
    };

    const ctrlC = await sendAndGet("\x03");
    expect(Array.from(ctrlC)).toEqual([0x03]);

    // \n is normalized to \r (carriage return) for terminal Enter
    const enter = await sendAndGet("\n");
    expect(Array.from(enter)).toEqual([0x0d]);

    const plain = await sendAndGet("hello");
    expect(new TextDecoder().decode(plain)).toBe("hello");

    // Command with \n gets \n normalized to \r
    const commandWithEnter = await sendAndGet("echo hello\n");
    expect(new TextDecoder().decode(commandWithEnter)).toBe("echo hello\r");
  });

  test("wait resolves early when wait_for.pattern matches", async () => {
    const e2b = makeFakeE2BSandbox();
    const handle = makeFakeHandle();

    const { context } = makeContext({ sandbox: e2b });
    const sessionId = await createSession(context, handle);

    const tool = createInteractTerminalSession(context);
    const startedAt = Date.now();
    const waitP = runTool(tool, {
      action: "wait",
      session: sessionId,
      wait_for: { pattern: "READY", timeout_ms: 2000, idle_ms: 5 },
    });
    setTimeout(() => handle.emit(new TextEncoder().encode("hello READY\n")), 5);
    const result = (await waitP) as { result: { output: string } };
    expect(result.result.output).toContain("READY");
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  test("wait resolves on idle after idle_ms with no new output", async () => {
    const e2b = makeFakeE2BSandbox();
    const handle = makeFakeHandle();

    const { context } = makeContext({ sandbox: e2b });
    const sessionId = await createSession(context, handle);

    const tool = createInteractTerminalSession(context);
    const started = Date.now();
    const result = (await runTool(tool, {
      action: "wait",
      session: sessionId,
      wait_for: { idle_ms: 30, timeout_ms: 1000 },
    })) as { result: { output: string } };
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    expect(Date.now() - started).toBeLessThan(500);
    expect(typeof result.result.output).toBe("string");
  });

  test("view returns snapshot without advancing readCursor", async () => {
    const e2b = makeFakeE2BSandbox();
    const handle = makeFakeHandle();

    const { context } = makeContext({ sandbox: e2b });
    const sessionId = await createSession(context, handle);

    handle.emit(new TextEncoder().encode("hello\n"));
    // wait to drain that into the buffer
    await new Promise((r) => setTimeout(r, 10));

    const tool = createInteractTerminalSession(context);

    const view1 = (await runTool(tool, {
      action: "view",
      session: sessionId,
    })) as { result: { output: string } };

    // subsequent wait should still see same bytes (view did not consume them)
    const waitRes = (await runTool(tool, {
      action: "wait",
      session: sessionId,
      wait_for: { idle_ms: 5, timeout_ms: 200 },
    })) as { result: { output: string } };

    expect(view1.result.output).toContain("hello");
    expect(waitRes.result.output).toContain("hello");
  });

  test("kill closes the session and returns exitCode", async () => {
    const e2b = makeFakeE2BSandbox();
    const handle = makeFakeHandle();

    const { context, ptySessionManager } = makeContext({ sandbox: e2b });
    const sessionId = await createSession(context, handle);

    const tool = createInteractTerminalSession(context);
    const result = (await runTool(tool, {
      action: "kill",
      session: sessionId,
    })) as { result: { exitCode: number | null } };

    expect(result.result.exitCode).toBe(0);
    expect(ptySessionManager.get("chat-1", sessionId)).toBeUndefined();
  });

  test("bufferTruncated surfaces in response when ring drops data", async () => {
    const e2b = makeFakeE2BSandbox();
    const handle = makeFakeHandle();

    const { context, ptySessionManager } = makeContext({ sandbox: e2b });
    const sessionId = await createSession(context, handle);

    // Manually flip bufferTruncated on the session (simulating ring drop).
    const session = ptySessionManager.get("chat-1", sessionId)!;
    (session as unknown as { bufferTruncated: boolean }).bufferTruncated = true;

    const tool = createInteractTerminalSession(context);
    const view = (await runTool(tool, {
      action: "view",
      session: sessionId,
    })) as { result: { bufferTruncated?: boolean } };
    expect(view.result.bufferTruncated).toBe(true);
  });

  test("ANSI escape sequences are stripped from model-facing output", async () => {
    const e2b = makeFakeE2BSandbox();
    const handle = makeFakeHandle();

    const { context } = makeContext({ sandbox: e2b });
    const sessionId = await createSession(context, handle);

    // ANSI red + "HI" + reset
    handle.emit(new TextEncoder().encode("\x1b[31mHI\x1b[0m\n"));
    await new Promise((r) => setTimeout(r, 10));

    const tool = createInteractTerminalSession(context);
    const result = (await runTool(tool, {
      action: "view",
      session: sessionId,
    })) as { result: { output: string } };
    expect(result.result.output).toContain("HI");
    expect(result.result.output).not.toContain("\x1b[31m");
    expect(result.result.output).not.toContain("\x1b[0m");
  });

  // ── FIX 1 — invalid wait_for.pattern returns structured error ───────
  test("wait with invalid regex returns structured error, does not crash", async () => {
    const e2b = makeFakeE2BSandbox();
    const handle = makeFakeHandle();

    const { context } = makeContext({ sandbox: e2b });
    const sessionId = await createSession(context, handle);

    const tool = createInteractTerminalSession(context);
    const result = (await runTool(tool, {
      action: "wait",
      session: sessionId,
      wait_for: { pattern: "[unclosed", idle_ms: 100, timeout_ms: 200 },
    })) as { result: { error?: string } };

    expect(result.result.error).toMatch(/Invalid wait_for\.pattern/);
  });

  // ── FIX 2 — zod caps on wait_for durations ──────────────────────────
  test("wait_for.idle_ms above 60000 cap is rejected by zod", async () => {
    const e2b = makeFakeE2BSandbox();
    const { context } = makeContext({ sandbox: e2b });
    const tool = createInteractTerminalSession(context);

    // zod validation happens inside the ai SDK's tool wrapper — calling
    // execute() directly here bypasses zod, so instead we parse the schema
    // manually via the tool's inputSchema.
    const schema = (
      tool as unknown as {
        inputSchema: {
          safeParse: (v: unknown) => { success: boolean; error?: unknown };
        };
      }
    ).inputSchema;
    const resultOver = schema.safeParse({
      action: "wait",
      session: "s",
      wait_for: { idle_ms: 120_000, timeout_ms: 200 },
    });
    expect(resultOver.success).toBe(false);

    const resultOk = schema.safeParse({
      action: "wait",
      session: "s",
      wait_for: { idle_ms: 10_000, timeout_ms: 200 },
    });
    expect(resultOk.success).toBe(true);
  });

  test("wait_for.timeout_ms above 300000 cap is rejected by zod", async () => {
    const e2b = makeFakeE2BSandbox();
    const { context } = makeContext({ sandbox: e2b });
    const tool = createInteractTerminalSession(context);
    const schema = (
      tool as unknown as {
        inputSchema: { safeParse: (v: unknown) => { success: boolean } };
      }
    ).inputSchema;
    const over = schema.safeParse({
      action: "wait",
      session: "s",
      wait_for: { idle_ms: 100, timeout_ms: 600_000 },
    });
    expect(over.success).toBe(false);
  });

  // ── action=wait when process already exited ──────────────────────────
  test("action=wait returns exited with exitCode when process already exited", async () => {
    const e2b = makeFakeE2BSandbox();
    const handle = makeFakeHandle();

    const { context, ptySessionManager } = makeContext({ sandbox: e2b });
    const sessionId = await createSession(context, handle);

    // Resolve the exit — the handle.exited promise settles.
    handle.resolveExit(42);

    const tool = createInteractTerminalSession(context);
    // Immediately start the wait call BEFORE yielding to microtasks — the
    // session is still in the manager because removeSession runs in a
    // .then() microtask that hasn't fired yet.
    const waitP = runTool(tool, {
      action: "wait",
      session: sessionId,
      wait_for: { idle_ms: 10, timeout_ms: 500 },
    }) as Promise<{
      result: {
        exited?: { exitCode: number | null };
        output?: string;
        error?: string;
      };
    }>;

    const result = await waitP;

    // If the session was still reachable, result.exited should be surfaced.
    // If the session was already removed, we get a "Session not found" error.
    // Either path is acceptable — the critical thing is we don't hang or crash.
    if (result.result.error) {
      // Session was cleaned up before wait ran — verify it's the expected error
      expect(result.result.error).toMatch(/not found/i);
    } else {
      // The wait captured the already-exited state
      expect(result.result.exited).toBeDefined();
      expect(result.result.exited!.exitCode).toBe(42);
    }
  });

  // ── FIX 6 — sendInput rejection surfaces as structured error ─────────
  test("send returns structured error when handle.sendInput rejects", async () => {
    const e2b = makeFakeE2BSandbox();
    const handle = makeFakeHandle();

    const { context } = makeContext({ sandbox: e2b });
    const sessionId = await createSession(context, handle);

    // Now rewire sendInput to reject on the NEXT call.
    (handle.sendInput as unknown as jest.Mock).mockImplementationOnce(
      async () => {
        throw new Error("pipe broken");
      },
    );

    const tool = createInteractTerminalSession(context);
    const result = (await runTool(tool, {
      action: "send",
      session: sessionId,
      input: "hi\n",
    })) as { result: { error?: string } };

    expect(result.result.error).toMatch(/Failed to send input: pipe broken/);
  });
});
