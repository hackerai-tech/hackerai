/**
 * Tests for `run_terminal_cmd` — focusing on the interactive PTY action
 * dispatch added by the PTY MVP (/Users/fkesheh/.claude/plans/fluffy-splashing-hoare.md).
 *
 * The non-interactive (`action=exec`, `interactive=false`) path is already
 * covered by higher-level integration tests. Here we verify:
 *  - the dispatch contract for {exec+interactive, send, wait, view, kill}
 *  - input size cap
 *  - pty-keys decoding (Enter / C-c / plain text)
 *  - wait policy (pattern + idle)
 *  - ANSI stripping + bufferTruncated surfacing
 *  - structured errors for non-E2B sandboxes and missing sessions
 *  - that the legacy schema ({command, explanation, is_background, timeout})
 *    still flows through and produces a shaped result.
 */

// Stub out @e2b/code-interpreter — its ESM `chalk` dependency trips Jest's
// default transformer. We only need the named exports that appear in
// `run-terminal-cmd.ts` to be importable.
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

import { createRunTerminalCmd } from "../run-terminal-cmd";
import type { PtyHandle } from "../utils/e2b-pty-adapter";
import { PtySessionManager } from "../utils/pty-session-manager";

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

  // Match the real `isE2BSandbox` discriminator from sandbox-types.ts:
  //   - reject if sandboxKind === "centrifugo" (Centrifugo mock)
  //   - accept only if `jupyterUrl` (string) OR `pty` (object) is present
  //   - reject partial mocks lacking both (treated as non-E2B)
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

describe("run_terminal_cmd — PTY action dispatch", () => {
  beforeEach(() => {
    mockCreateE2BPtyHandle.mockReset();
  });

  test("regression: legacy schema {command, explanation, is_background, timeout} still works", async () => {
    // Use a non-E2B sandbox (sandboxKind !== "centrifugo" is NOT enough after
    // the isE2BSandbox hardening — a sandbox with sandboxKind: "centrifugo" is
    // explicitly non-E2B and bypasses the E2B health check entirely).
    const nonE2B = {
      sandboxKind: "centrifugo" as const,
      isWindows: () => false,
      commands: {
        // The tool's handler reads output via the onStdout callback (not from
        // the resolved value), so we feed the mock stream through there.
        run: jest.fn(
          async (_cmd: string, opts?: { onStdout?: (s: string) => void }) => {
            opts?.onStdout?.("hi\n");
            return { stdout: "hi\n", stderr: "", exitCode: 0 };
          },
        ),
      },
    };

    const { context } = makeContext({ sandbox: nonE2B });
    const tool = createRunTerminalCmd(context);

    const result = (await runTool(tool, {
      command: "echo hi",
      explanation: "say hi",
      is_background: false,
      timeout: 5,
    })) as {
      result: {
        output: string;
        exitCode: number | null;
        session?: string;
        pid?: number;
      };
    };

    expect(result).toHaveProperty("result");
    expect(typeof result.result.output).toBe("string");
    expect(result.result.output).toContain("hi");
    // Foreground non-background returns an exitCode (may be null on timeout paths,
    // but here the mock resolves with 0).
    expect(result.result.exitCode).toBe(0);
    // The legacy foreground path must NOT return interactive-PTY fields.
    expect(result.result.session).toBeUndefined();
    expect(result.result.pid).toBeUndefined();
    // commands.run was invoked exactly once with the command.
    expect(nonE2B.commands.run).toHaveBeenCalledTimes(1);
    expect(
      (nonE2B.commands.run as jest.Mock).mock.calls[0][0] as string,
    ).toContain("echo hi");
  });

  test("schema defaults action=exec and interactive=false when omitted", async () => {
    // A bare `{command, explanation}` must flow through the legacy path
    // (action defaults to "exec", interactive to false) — no session/pid.
    const nonE2B = {
      sandboxKind: "centrifugo" as const,
      isWindows: () => false,
      commands: {
        run: jest
          .fn()
          .mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
      },
    };
    const { context } = makeContext({ sandbox: nonE2B });
    const tool = createRunTerminalCmd(context);
    const result = (await runTool(tool, {
      command: "true",
      explanation: "default dispatch",
    })) as { result: { session?: string; exitCode: number | null } };
    expect(result.result.session).toBeUndefined();
    expect(result.result.exitCode).toBe(0);
  });

  test("exec + interactive=true on non-E2B sandbox returns a structured error", async () => {
    // `isE2BSandbox` checks `sandboxKind === "centrifugo"` to negate.
    const nonE2B = {
      sandboxKind: "centrifugo" as const,
      commands: { run: jest.fn() },
    };
    const { context } = makeContext({ sandbox: nonE2B });
    const tool = createRunTerminalCmd(context);

    const result = (await runTool(tool, {
      action: "exec",
      command: "top",
      explanation: "x",
      is_background: false,
      interactive: true,
    })) as { result: { error?: string; exitCode?: number } };

    expect(result.result.error).toMatch(/Interactive PTY requires E2B/);
    expect(result.result.exitCode).toBe(1);
  });

  test("exec + interactive=true on E2B creates a session and returns {session, pid, output}", async () => {
    const e2b = makeFakeE2BSandbox();
    const handle = makeFakeHandle(9999);
    mockCreateE2BPtyHandle.mockImplementation(async () => handle);

    const { context, ptySessionManager } = makeContext({ sandbox: e2b });
    const tool = createRunTerminalCmd(context);

    // Emit some output shortly after the command is sent so waitForOutput
    // idle timer resolves quickly.
    const p = runTool(tool, {
      action: "exec",
      command: "ls",
      explanation: "list",
      is_background: false,
      interactive: true,
      wait_for: { idle_ms: 20, timeout_ms: 1000 },
    });
    // Let the `exec` path send the command, then emit output.
    await new Promise((r) => setTimeout(r, 0));
    handle.emit(new TextEncoder().encode("file1\nfile2\n"));

    const result = (await p) as {
      result: { session: string; pid: number; output: string };
    };

    expect(result.result.pid).toBe(9999);
    expect(typeof result.result.session).toBe("string");
    expect(result.result.output).toContain("file1");
    // Command was sent through as initial input
    expect(handle.sendInputCalls.length).toBeGreaterThanOrEqual(1);
    expect(new TextDecoder().decode(handle.sendInputCalls[0])).toBe("ls\n");
    // Session is tracked
    expect(
      ptySessionManager.get("chat-1", result.result.session),
    ).toBeDefined();
  });

  test("send on unknown session returns structured error", async () => {
    const { context } = makeContext({ sandbox: makeFakeE2BSandbox() });
    const tool = createRunTerminalCmd(context);
    const result = (await runTool(tool, {
      action: "send",
      session: "nope",
      input: "hi\n",
      explanation: "x",
      is_background: false,
    })) as { result: { error?: string } };
    expect(result.result.error).toMatch(/Session nope not found/);
  });

  test("send with oversized input errors without calling sendInput", async () => {
    const e2b = makeFakeE2BSandbox();
    const handle = makeFakeHandle();
    mockCreateE2BPtyHandle.mockImplementation(async () => handle);

    const { context } = makeContext({ sandbox: e2b });
    const tool = createRunTerminalCmd(context);

    // First create a session.
    const execPromise = runTool(tool, {
      action: "exec",
      command: "sh",
      explanation: "x",
      is_background: false,
      interactive: true,
      wait_for: { idle_ms: 10, timeout_ms: 500 },
    });
    await new Promise((r) => setTimeout(r, 0));
    const created = (await execPromise) as {
      result: { session: string };
    };
    const sessionId = created.result.session;

    // Count of sendInput calls so far (1 — the initial command).
    const before = handle.sendInputCalls.length;

    const huge = "a".repeat(8 * 1024 + 1);
    const result = (await runTool(tool, {
      action: "send",
      session: sessionId,
      input: huge,
      explanation: "x",
      is_background: false,
    })) as { result: { error?: string } };

    expect(result.result.error).toMatch(/exceeds MAX_INPUT_BYTES_PER_SEND/);
    expect(handle.sendInputCalls.length).toBe(before);
  });

  test("send decodes tmux-style keys: C-c -> \\x03, Enter -> \\r, plain text verbatim", async () => {
    const e2b = makeFakeE2BSandbox();
    const handle = makeFakeHandle();
    mockCreateE2BPtyHandle.mockImplementation(async () => handle);

    const { context } = makeContext({ sandbox: e2b });
    const tool = createRunTerminalCmd(context);

    const created = (await (async () => {
      const p = runTool(tool, {
        action: "exec",
        command: "sh",
        explanation: "x",
        is_background: false,
        interactive: true,
        wait_for: { idle_ms: 10, timeout_ms: 500 },
      });
      await new Promise((r) => setTimeout(r, 0));
      return p;
    })()) as { result: { session: string } };
    const sessionId = created.result.session;

    const sendAndGet = async (input: string) => {
      const beforeLen = handle.sendInputCalls.length;
      void runTool(tool, {
        action: "send",
        session: sessionId,
        input,
        explanation: "x",
        is_background: false,
        wait_for: { idle_ms: 10, timeout_ms: 200 },
      });
      // Yield so the tool's awaited sendInput runs.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      return handle.sendInputCalls[beforeLen];
    };

    const ctrlC = await sendAndGet("C-c");
    expect(Array.from(ctrlC)).toEqual([0x03]);

    const enter = await sendAndGet("Enter");
    expect(Array.from(enter)).toEqual([0x0d]);

    const plain = await sendAndGet("hello");
    expect(new TextDecoder().decode(plain)).toBe("hello");
  });

  test("wait resolves early when wait_for.pattern matches", async () => {
    const e2b = makeFakeE2BSandbox();
    const handle = makeFakeHandle();
    mockCreateE2BPtyHandle.mockImplementation(async () => handle);

    const { context } = makeContext({ sandbox: e2b });
    const tool = createRunTerminalCmd(context);

    const execP = runTool(tool, {
      action: "exec",
      command: "read x",
      explanation: "x",
      is_background: false,
      interactive: true,
      wait_for: { idle_ms: 5, timeout_ms: 200 },
    });
    await new Promise((r) => setTimeout(r, 0));
    const created = (await execP) as { result: { session: string } };

    const startedAt = Date.now();
    const waitP = runTool(tool, {
      action: "wait",
      session: created.result.session,
      explanation: "x",
      is_background: false,
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
    mockCreateE2BPtyHandle.mockImplementation(async () => handle);

    const { context } = makeContext({ sandbox: e2b });
    const tool = createRunTerminalCmd(context);

    const execP = runTool(tool, {
      action: "exec",
      command: "sh",
      explanation: "x",
      is_background: false,
      interactive: true,
      wait_for: { idle_ms: 5, timeout_ms: 200 },
    });
    await new Promise((r) => setTimeout(r, 0));
    const created = (await execP) as { result: { session: string } };

    const started = Date.now();
    const result = (await runTool(tool, {
      action: "wait",
      session: created.result.session,
      explanation: "x",
      is_background: false,
      wait_for: { idle_ms: 30, timeout_ms: 1000 },
    })) as { result: { output: string } };
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    expect(Date.now() - started).toBeLessThan(500);
    expect(typeof result.result.output).toBe("string");
  });

  test("view returns snapshot without advancing readCursor", async () => {
    const e2b = makeFakeE2BSandbox();
    const handle = makeFakeHandle();
    mockCreateE2BPtyHandle.mockImplementation(async () => handle);

    const { context } = makeContext({ sandbox: e2b });
    const tool = createRunTerminalCmd(context);

    const execP = runTool(tool, {
      action: "exec",
      command: "sh",
      explanation: "x",
      is_background: false,
      interactive: true,
      wait_for: { idle_ms: 5, timeout_ms: 200 },
    });
    await new Promise((r) => setTimeout(r, 0));
    const created = (await execP) as { result: { session: string } };
    const sessionId = created.result.session;

    handle.emit(new TextEncoder().encode("hello\n"));
    // wait to drain that into the buffer
    await new Promise((r) => setTimeout(r, 10));

    const view1 = (await runTool(tool, {
      action: "view",
      session: sessionId,
      explanation: "x",
      is_background: false,
    })) as { result: { output: string } };

    // subsequent wait should still see same bytes (view did not consume them)
    const waitRes = (await runTool(tool, {
      action: "wait",
      session: sessionId,
      explanation: "x",
      is_background: false,
      wait_for: { idle_ms: 5, timeout_ms: 200 },
    })) as { result: { output: string } };

    expect(view1.result.output).toContain("hello");
    expect(waitRes.result.output).toContain("hello");
  });

  test("kill closes the session and returns exitCode", async () => {
    const e2b = makeFakeE2BSandbox();
    const handle = makeFakeHandle();
    mockCreateE2BPtyHandle.mockImplementation(async () => handle);

    const { context, ptySessionManager } = makeContext({ sandbox: e2b });
    const tool = createRunTerminalCmd(context);

    const execP = runTool(tool, {
      action: "exec",
      command: "sh",
      explanation: "x",
      is_background: false,
      interactive: true,
      wait_for: { idle_ms: 5, timeout_ms: 200 },
    });
    await new Promise((r) => setTimeout(r, 0));
    const created = (await execP) as { result: { session: string } };

    const result = (await runTool(tool, {
      action: "kill",
      session: created.result.session,
      explanation: "x",
      is_background: false,
    })) as { result: { exitCode: number | null } };

    expect(result.result.exitCode).toBe(0);
    expect(
      ptySessionManager.get("chat-1", created.result.session),
    ).toBeUndefined();
  });

  test("bufferTruncated surfaces in response when ring drops data", async () => {
    const e2b = makeFakeE2BSandbox();
    const handle = makeFakeHandle();
    mockCreateE2BPtyHandle.mockImplementation(async () => handle);

    const { context, ptySessionManager } = makeContext({ sandbox: e2b });
    const tool = createRunTerminalCmd(context);

    const execP = runTool(tool, {
      action: "exec",
      command: "cat bigfile",
      explanation: "x",
      is_background: false,
      interactive: true,
      wait_for: { idle_ms: 5, timeout_ms: 200 },
    });
    await new Promise((r) => setTimeout(r, 0));
    const created = (await execP) as { result: { session: string } };
    const sessionId = created.result.session;

    // Manually flip bufferTruncated on the session (simulating ring drop).
    const session = ptySessionManager.get("chat-1", sessionId)!;
    (session as unknown as { bufferTruncated: boolean }).bufferTruncated = true;

    const view = (await runTool(tool, {
      action: "view",
      session: sessionId,
      explanation: "x",
      is_background: false,
    })) as { result: { bufferTruncated?: boolean } };
    expect(view.result.bufferTruncated).toBe(true);
  });

  test("ANSI escape sequences are stripped from model-facing output", async () => {
    const e2b = makeFakeE2BSandbox();
    const handle = makeFakeHandle();
    mockCreateE2BPtyHandle.mockImplementation(async () => handle);

    const { context } = makeContext({ sandbox: e2b });
    const tool = createRunTerminalCmd(context);

    const execP = runTool(tool, {
      action: "exec",
      command: "ls --color=always",
      explanation: "x",
      is_background: false,
      interactive: true,
      wait_for: { idle_ms: 20, timeout_ms: 500 },
    });
    await new Promise((r) => setTimeout(r, 0));
    // ANSI red + "HI" + reset
    handle.emit(new TextEncoder().encode("\x1b[31mHI\x1b[0m\n"));
    const result = (await execP) as { result: { output: string } };
    expect(result.result.output).toContain("HI");
    expect(result.result.output).not.toContain("\x1b[31m");
    expect(result.result.output).not.toContain("\x1b[0m");
  });

  // ── FIX 1 — invalid wait_for.pattern returns structured error ───────
  test("wait with invalid regex returns structured error, does not crash", async () => {
    const e2b = makeFakeE2BSandbox();
    const handle = makeFakeHandle();
    mockCreateE2BPtyHandle.mockImplementation(async () => handle);

    const { context } = makeContext({ sandbox: e2b });
    const tool = createRunTerminalCmd(context);

    // Open a session
    const execP = runTool(tool, {
      action: "exec",
      command: "sh",
      explanation: "x",
      is_background: false,
      interactive: true,
      wait_for: { idle_ms: 5, timeout_ms: 200 },
    });
    await new Promise((r) => setTimeout(r, 0));
    const created = (await execP) as { result: { session: string } };

    const result = (await runTool(tool, {
      action: "wait",
      session: created.result.session,
      explanation: "x",
      is_background: false,
      wait_for: { pattern: "[unclosed", idle_ms: 100, timeout_ms: 200 },
    })) as { result: { error?: string } };

    expect(result.result.error).toMatch(/Invalid wait_for\.pattern/);
  });

  // ── FIX 2 — zod caps on wait_for durations ──────────────────────────
  test("wait_for.idle_ms above 60000 cap is rejected by zod", async () => {
    const e2b = makeFakeE2BSandbox();
    const { context } = makeContext({ sandbox: e2b });
    const tool = createRunTerminalCmd(context);

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
      explanation: "x",
      is_background: false,
      wait_for: { idle_ms: 120_000, timeout_ms: 200 },
    });
    expect(resultOver.success).toBe(false);

    const resultOk = schema.safeParse({
      action: "wait",
      session: "s",
      explanation: "x",
      is_background: false,
      wait_for: { idle_ms: 10_000, timeout_ms: 200 },
    });
    expect(resultOk.success).toBe(true);
  });

  test("wait_for.timeout_ms above 300000 cap is rejected by zod", async () => {
    const e2b = makeFakeE2BSandbox();
    const { context } = makeContext({ sandbox: e2b });
    const tool = createRunTerminalCmd(context);
    const schema = (
      tool as unknown as {
        inputSchema: { safeParse: (v: unknown) => { success: boolean } };
      }
    ).inputSchema;
    const over = schema.safeParse({
      action: "wait",
      session: "s",
      explanation: "x",
      is_background: false,
      wait_for: { idle_ms: 100, timeout_ms: 600_000 },
    });
    expect(over.success).toBe(false);
  });

  // ── FIX 3 — partial sandbox lacking positive E2B evidence is non-E2B ─
  test("sandbox lacking jupyterUrl + pty is treated as non-E2B (interactive=true returns error)", async () => {
    // No sandboxKind, no jupyterUrl, no pty — the hardened isE2BSandbox
    // requires positive evidence and should reject this.
    const partial = {
      commands: { run: jest.fn() },
    };
    const { context } = makeContext({ sandbox: partial });
    const tool = createRunTerminalCmd(context);

    const result = (await runTool(tool, {
      action: "exec",
      command: "top",
      explanation: "x",
      is_background: false,
      interactive: true,
    })) as { result: { error?: string; exitCode?: number } };

    expect(result.result.error).toMatch(/Interactive PTY requires E2B/);
    expect(result.result.exitCode).toBe(1);
  });

  // ── FIX 4 — factory is not invoked when cap is already hit ───────────
  test("ptySessionManager.create does NOT invoke factory when concurrency cap is hit", async () => {
    const e2b = makeFakeE2BSandbox();

    const { context, ptySessionManager } = makeContext({ sandbox: e2b });
    // Seed the manager with 2 existing sessions (MAX=2) against the same chat.
    const h1 = makeFakeHandle(1);
    const h2 = makeFakeHandle(2);
    await ptySessionManager.create("chat-1", {
      createHandle: async () => h1,
      cols: 80,
      rows: 24,
    });
    await ptySessionManager.create("chat-1", {
      createHandle: async () => h2,
      cols: 80,
      rows: 24,
    });

    // Now attempt a 3rd through the tool — factory must NOT be invoked.
    const factory = jest.fn();
    mockCreateE2BPtyHandle.mockImplementation(factory as never);

    const result = (await runTool(tool(context), {
      action: "exec",
      command: "sh",
      explanation: "x",
      is_background: false,
      interactive: true,
    })) as { result: { error?: string } };

    expect(factory).not.toHaveBeenCalled();
    expect(result.result.error).toMatch(/MAX_CONCURRENT_PTYS_PER_CHAT/);

    function tool(ctx: Parameters<typeof createRunTerminalCmd>[0]) {
      return createRunTerminalCmd(ctx);
    }
  });

  test("if createHandle factory throws, no session is stored", async () => {
    const e2b = makeFakeE2BSandbox();
    mockCreateE2BPtyHandle.mockImplementation(async () => {
      throw new Error("spawn failed");
    });
    const { context, ptySessionManager } = makeContext({ sandbox: e2b });
    const tool = createRunTerminalCmd(context);

    const result = (await runTool(tool, {
      action: "exec",
      command: "sh",
      explanation: "x",
      is_background: false,
      interactive: true,
    })) as { result: { error?: string } };

    expect(result.result.error).toMatch(/spawn failed/);
    expect(ptySessionManager.list("chat-1")).toEqual([]);
  });

  // ── FIX 6 — sendInput rejection surfaces as structured error ─────────
  test("send returns structured error when handle.sendInput rejects", async () => {
    const e2b = makeFakeE2BSandbox();
    const handle = makeFakeHandle();
    mockCreateE2BPtyHandle.mockImplementation(async () => handle);

    const { context } = makeContext({ sandbox: e2b });
    const tool = createRunTerminalCmd(context);

    const execP = runTool(tool, {
      action: "exec",
      command: "sh",
      explanation: "x",
      is_background: false,
      interactive: true,
      wait_for: { idle_ms: 5, timeout_ms: 200 },
    });
    await new Promise((r) => setTimeout(r, 0));
    const created = (await execP) as { result: { session: string } };

    // Now rewire sendInput to reject on the NEXT call.
    (handle.sendInput as unknown as jest.Mock).mockImplementationOnce(
      async () => {
        throw new Error("pipe broken");
      },
    );

    const result = (await runTool(tool, {
      action: "send",
      session: created.result.session,
      input: "hi\n",
      explanation: "x",
      is_background: false,
    })) as { result: { error?: string } };

    expect(result.result.error).toMatch(/Failed to send input: pipe broken/);
  });
});
