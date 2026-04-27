/**
 * Tests for `run_terminal_cmd` — focusing on exec and interactive session creation.
 *
 * The non-interactive (`action=exec`, `interactive=false`) path is already
 * covered by higher-level integration tests. Here we verify:
 *  - the dispatch contract for {exec, exec+interactive}
 *  - structured errors for non-E2B sandboxes and missing sessions
 *  - that the legacy schema ({command, explanation, is_background, timeout})
 *    still flows through and produces a shaped result.
 *
 * PTY session action tests (send, wait, view, kill) are in
 * interact-terminal-session.test.ts.
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

import { createCentrifugoPtyHandle } from "../utils/centrifugo-pty-adapter";
const mockCreateCentrifugoPtyHandle =
  createCentrifugoPtyHandle as jest.MockedFunction<
    typeof createCentrifugoPtyHandle
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
    mockCreateCentrifugoPtyHandle.mockReset();
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

  test("exec + interactive=true on Centrifugo sandbox invokes createCentrifugoPtyHandle", async () => {
    const fakeHandle = makeFakeHandle();
    mockCreateCentrifugoPtyHandle.mockResolvedValue(fakeHandle);

    const centrifugoSandbox = {
      sandboxKind: "centrifugo" as const,
      commands: { run: jest.fn() },
      getUserId: () => "user-1",
      getConnectionId: () => "conn-1",
      getConfig: () => ({ wsUrl: "ws://fake", tokenSecret: "secret" }),
      isWindows: () => false,
    };
    const { context } = makeContext({ sandbox: centrifugoSandbox });
    const tool = createRunTerminalCmd(context);

    // Emit some data so waitForOutput resolves
    setTimeout(() => {
      fakeHandle.emit(new TextEncoder().encode("$ top\n"));
      fakeHandle.resolveExit(0);
    }, 50);

    const result = (await runTool(tool, {
      action: "exec",
      command: "top",
      explanation: "x",
      is_background: false,
      interactive: true,
      timeout: 0.2,
    })) as { result: { output?: string; session?: string; pid?: number } };

    expect(mockCreateCentrifugoPtyHandle).toHaveBeenCalledTimes(1);
    expect(result.result.session).toBeDefined();
    expect(result.result.pid).toBe(fakeHandle.pid);
  });

  test("exec + interactive=true on Centrifugo sandbox does NOT send initial command via sendInput", async () => {
    const fakeHandle = makeFakeHandle();
    mockCreateCentrifugoPtyHandle.mockResolvedValue(fakeHandle);

    const centrifugoSandbox = {
      sandboxKind: "centrifugo" as const,
      commands: { run: jest.fn() },
      getUserId: () => "user-1",
      getConnectionId: () => "conn-1",
      getConfig: () => ({ wsUrl: "ws://fake", tokenSecret: "secret" }),
      isWindows: () => false,
    };
    const { context } = makeContext({ sandbox: centrifugoSandbox });
    const tool = createRunTerminalCmd(context);

    setTimeout(() => {
      fakeHandle.emit(new TextEncoder().encode("output\n"));
      fakeHandle.resolveExit(0);
    }, 50);

    await runTool(tool, {
      action: "exec",
      command: "top",
      explanation: "x",
      is_background: false,
      interactive: true,
      timeout: 0.2,
    });

    // Centrifugo PTY sends the command in pty_create, so sendInput
    // must NOT be called with the initial "command\n".
    expect(fakeHandle.sendInputCalls).toHaveLength(0);
  });

  test("exec + interactive=true on E2B creates a session and returns {session, pid, output}", async () => {
    const e2b = makeFakeE2BSandbox();
    const handle = makeFakeHandle(9999);
    mockCreateE2BPtyHandle.mockImplementation(async () => handle);

    const { context, ptySessionManager } = makeContext({ sandbox: e2b });
    const tool = createRunTerminalCmd(context);

    // Emit some output shortly after the command is sent so the test
    // captures it before the timeout fires.
    const p = runTool(tool, {
      action: "exec",
      command: "ls",
      explanation: "list",
      is_background: false,
      interactive: true,
      timeout: 1,
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

  // ── FIX 4 — factory is not invoked when cap is already hit ───────────
  test("ptySessionManager.create does NOT invoke factory when concurrency cap is hit", async () => {
    const e2b = makeFakeE2BSandbox();

    const { context, ptySessionManager } = makeContext({ sandbox: e2b });
    // Seed the manager with MAX_CONCURRENT_PTYS_PER_CHAT existing sessions
    // against the same chat so the next create must reject.
    for (let i = 0; i < MAX_CONCURRENT_PTYS_PER_CHAT; i++) {
      const h = makeFakeHandle(i + 1);
      await ptySessionManager.create("chat-1", {
        createHandle: async () => h,
        cols: 80,
        rows: 24,
      });
    }

    // Now attempt one over the cap through the tool — factory must NOT be invoked.
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
});
