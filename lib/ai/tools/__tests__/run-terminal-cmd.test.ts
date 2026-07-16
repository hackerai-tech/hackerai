/**
 * Tests for `run_terminal_cmd` — focusing on exec and interactive session creation.
 *
 * The non-interactive (`action=exec`, `interactive=false`) path is already
 * covered by higher-level integration tests. Here we verify:
 *  - the dispatch contract for {exec, exec+interactive}
 *  - structured errors for non-E2B sandboxes and missing sessions
 *  - that the legacy schema ({command, brief, is_background, timeout})
 *    still flows through and produces a shaped result.
 *  - that command-only input works because `brief` is display metadata.
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

jest.mock("@/lib/posthog/server", () => ({
  phLogger: {
    event: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    flush: jest.fn(),
  },
}));

import { phLogger } from "@/lib/posthog/server";
import { createRunTerminalCmd } from "../run-terminal-cmd";
import { detectAgentBrowserUsage } from "../utils/agent-browser-usage";
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
  requestToolApproval?: import("@/types").AgentToolApprovalRequester;
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
    backgroundProcessTracker: {
      addProcess: jest.fn(),
    } as never,
    ptySessionManager,
    mode: "agent",
    modelName: "configured-model",
    getCurrentModelName: () => "active-model",
    subscription: "pro",
    requestToolApproval: opts.requestToolApproval,
    isE2BSandbox: (s: unknown) => {
      if (!s || typeof s !== "object") return false;
      if ((s as { sandboxKind?: unknown }).sandboxKind === "centrifugo")
        return false;
      const sb = s as { jupyterUrl?: unknown; pty?: unknown };
      return typeof sb.jupyterUrl === "string" || typeof sb.pty === "object";
    },
  } as unknown as import("@/types").ToolContext;

  return { context, writerWrites, sandboxManager, ptySessionManager };
}

const mockPhEvent = phLogger.event as jest.MockedFunction<
  typeof phLogger.event
>;

// Helper: invoke the tool.execute with given args/options.
async function runTool(
  tool: ReturnType<typeof createRunTerminalCmd>,
  input: Record<string, unknown>,
  abortSignal?: AbortSignal,
) {
  const execute = (
    tool as unknown as {
      execute: (i: unknown, o: unknown) => Promise<unknown>;
    }
  ).execute;
  return execute(input, {
    toolCallId: "call-1",
    abortSignal,
    messages: [],
  });
}

describe("run_terminal_cmd — PTY action dispatch", () => {
  beforeEach(() => {
    mockCreateE2BPtyHandle.mockReset();
    mockCreateCentrifugoPtyHandle.mockReset();
    mockPhEvent.mockClear();
  });

  test("forwards the user-facing justification and reusable argv prefix", async () => {
    const nonE2B = {
      sandboxKind: "centrifugo" as const,
      isWindows: () => false,
      commands: {
        run: jest.fn(
          async (_cmd: string, opts?: { onStdout?: (s: string) => void }) => {
            opts?.onStdout?.("ok\n");
            return { stdout: "ok\n", stderr: "", exitCode: 0 };
          },
        ),
      },
    };
    const requestToolApproval = jest.fn(async () => ({
      approved: true as const,
      approvalId: "approval-1",
    }));
    const { context } = makeContext({
      sandbox: nonE2B,
      requestToolApproval,
    });

    await runTool(createRunTerminalCmd(context), {
      command: "ping -c 4 hackerone.com",
      brief: "check reachability",
      justification: "Check whether the target host is reachable.",
      prefix_rule: ["ping", "-c", "4"],
      is_background: false,
      timeout: 5,
      interactive: false,
    });

    expect(requestToolApproval).toHaveBeenCalledWith({
      toolCallId: "call-1",
      toolName: "run_terminal_cmd",
      operation: "terminal_execute",
      target: "ping -c 4 hackerone.com",
      brief: "check reachability",
      justification: "Check whether the target host is reachable.",
      prefixRule: ["ping", "-c", "4"],
    });
  });

  test("detectAgentBrowserUsage extracts sanitized actions", () => {
    const usage = detectAgentBrowserUsage(
      "agent-browser open https://secret.example/login && agent-browser snapshot -i",
    );

    expect(usage).toEqual({
      invocationCount: 2,
      primaryAction: "open",
      actions: ["open", "snapshot"],
      usedViaNpx: false,
    });
    expect(JSON.stringify(usage)).not.toContain("secret.example");
  });

  test("detectAgentBrowserUsage supports env prefixes and npx", () => {
    expect(
      detectAgentBrowserUsage(
        "AGENT_BROWSER_SESSION_NAME=scan npx -y agent-browser@0.26.0 click @e3",
      ),
    ).toEqual({
      invocationCount: 1,
      primaryAction: "click",
      actions: ["click"],
      usedViaNpx: true,
    });
  });

  test("detectAgentBrowserUsage ignores whitespace-only mentions", () => {
    expect(detectAgentBrowserUsage("echo agent-browser open")).toBeNull();
    expect(detectAgentBrowserUsage("agent-browser-next open")).toBeNull();
  });

  test("regression: legacy schema {command, brief, is_background, timeout} still works", async () => {
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
      brief: "say hi",
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

  test("returns a real opaque session when a foreground command outlives its wait window", async () => {
    let finishCommand!: (result: {
      stdout: string;
      stderr: string;
      exitCode: number;
    }) => void;
    let streamStdout: ((data: string) => void) | undefined;
    const pendingCommand = new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
    }>((resolve) => {
      finishCommand = resolve;
    });
    const nonE2B = {
      sandboxKind: "centrifugo" as const,
      isWindows: () => false,
      commands: {
        run: jest.fn(
          async (
            _command: string,
            opts?: { onStdout?: (data: string) => void },
          ) => {
            streamStdout = opts?.onStdout;
            return pendingCommand;
          },
        ),
      },
    };

    const { context, ptySessionManager } = makeContext({ sandbox: nonE2B });
    const result = (await runTool(createRunTerminalCmd(context), {
      command: "whois hackerai.co",
      brief: "query WHOIS",
      is_background: false,
      timeout: 0.01,
      interactive: false,
    })) as {
      result: {
        output: string;
        session?: string;
        timedOut?: boolean;
        exitCode: number | null;
      };
    };

    expect(result.result.timedOut).toBe(true);
    expect(result.result.exitCode).toBeNull();
    expect(result.result.session).toMatch(/^[a-f0-9]{8}$/);
    expect(result.result.session).not.toBe("cmd-1689");
    expect(result.result.output).toContain(
      `terminal session ${result.result.session}`,
    );
    expect(result.result.output).toContain(
      "Use interact_terminal_session with this exact session ID",
    );

    const session = ptySessionManager.get("chat-1", result.result.session!);
    expect(session?.kind).toBe("command");

    streamStdout?.("WHOIS complete\n");
    finishCommand({ stdout: "WHOIS complete\n", stderr: "", exitCode: 0 });
    await expect(session?.handle.exited).resolves.toEqual({ exitCode: 0 });
    expect(
      new TextDecoder().decode(ptySessionManager.snapshot(session!)),
    ).toContain("WHOIS complete");

    ptySessionManager.forget("chat-1", result.result.session!);
  });

  test("uses the exact E2B command handle to terminate noisy foreground work", async () => {
    const noisyOutput = "line with repeated output\n".repeat(20_000);
    let rejectWait!: (error: Error) => void;
    const wait = new Promise<never>((_resolve, reject) => {
      rejectWait = reject;
    });
    const started = {
      pid: 4321,
      stdout: "",
      stderr: "",
      wait: jest.fn(() => wait),
      kill: jest.fn(async () => {
        rejectWait(new Error("signal: killed"));
        return true;
      }),
    };
    const run = jest.fn(
      async (
        calledCommand: string,
        opts?: {
          background?: boolean;
          onStdout?: (data: string) => void;
        },
      ) => {
        if (calledCommand === "echo ready") {
          return { stdout: "ready\n", stderr: "", exitCode: 0 };
        }
        if (calledCommand === "ps -p 4321") {
          return { stdout: "", stderr: "", exitCode: 1 };
        }
        expect(opts?.background).toBe(true);
        opts?.onStdout?.(noisyOutput);
        return started;
      },
    );
    const e2b = {
      jupyterUrl: "http://fake",
      commands: { run },
      isRunning: jest.fn(async () => true),
      getMetrics: jest.fn(async () => []),
    };

    const { context } = makeContext({ sandbox: e2b });
    const result = (await runTool(createRunTerminalCmd(context), {
      command: "yes",
      brief: "run noisy command",
      is_background: false,
      timeout: 0.01,
      interactive: false,
    })) as {
      result: {
        output: string;
        exitCode: number | null;
        terminatedOnTimeout?: boolean;
      };
    };

    expect(started.kill).toHaveBeenCalledTimes(1);
    expect(result.result.exitCode).toBe(124);
    expect(result.result.terminatedOnTimeout).toBe(true);
    expect(result.result.output).toContain("PID: 4321");
    expect(
      run.mock.calls.some(([calledCommand]) =>
        String(calledCommand).includes("pgrep"),
      ),
    ).toBe(false);
  });

  test("marks detached background PIDs as non-resumable", async () => {
    const nonE2B = {
      sandboxKind: "centrifugo" as const,
      isWindows: () => false,
      commands: {
        run: jest.fn().mockResolvedValue({
          stdout: "",
          stderr: "",
          exitCode: 0,
          pid: 1689,
        }),
      },
    };

    const { context } = makeContext({ sandbox: nonE2B });
    const result = (await runTool(createRunTerminalCmd(context), {
      command: "sleep 30",
      is_background: true,
      timeout: 5,
      interactive: false,
    })) as {
      result: {
        output: string;
        pid?: number;
        session?: string;
        resumable?: boolean;
      };
    };

    expect(result.result.pid).toBe(1689);
    expect(result.result.session).toBeUndefined();
    expect(result.result.resumable).toBe(false);
    expect(result.result.output).toContain(
      "do not pass this PID to interact_terminal_session",
    );
  });

  test("does not block destructive-looking commands", async () => {
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
      command: "rm -rf /",
      brief: "run command",
      is_background: false,
      timeout: 5,
    })) as { result: { error?: string; exitCode: number | null } };

    expect(result.result.error).toBeUndefined();
    expect(result.result.exitCode).toBe(0);
    expect(nonE2B.commands.run).toHaveBeenCalledTimes(1);
    expect(
      (nonE2B.commands.run as jest.Mock).mock.calls[0][0] as string,
    ).toContain("rm -rf /");
  });

  test("cancels noisy foreground commands through their execution-specific token", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const noisyOutput = "line with repeated output\n".repeat(20_000);
    const cancellationObserved = jest.fn();
    const nonE2B = {
      sandboxKind: "centrifugo" as const,
      isWindows: () => false,
      commands: {
        run: jest.fn(
          async (
            _command: string,
            opts?: {
              onStdout?: (s: string) => void;
              signal?: AbortSignal;
            },
          ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
            opts?.onStdout?.(noisyOutput);
            return new Promise((resolve) => {
              opts?.signal?.addEventListener(
                "abort",
                () => {
                  cancellationObserved();
                  resolve({ stdout: "", stderr: "", exitCode: 130 });
                },
                { once: true },
              );
            });
          },
        ),
      },
    };

    try {
      const { context } = makeContext({ sandbox: nonE2B });
      const tool = createRunTerminalCmd(context);

      const result = (await runTool(tool, {
        command: "yes",
        brief: "run noisy command",
        is_background: false,
        timeout: 0.01,
      })) as {
        result: {
          output: string;
          exitCode: number | null;
          terminatedOnTimeout?: boolean;
        };
      };

      expect(result.result.exitCode).toBe(124);
      expect(result.result.terminatedOnTimeout).toBe(true);
      expect(result.result.output).toContain(
        "noisy foreground process was terminated",
      );
      expect(cancellationObserved).toHaveBeenCalledTimes(1);
      expect(
        nonE2B.commands.run.mock.calls.some(([calledCommand]) =>
          String(calledCommand).includes("pgrep"),
        ),
      ).toBe(false);

      const noisyTimeoutLog = warnSpy.mock.calls
        .map(([line]) => {
          try {
            return JSON.parse(String(line));
          } catch {
            return null;
          }
        })
        .find((line) => line?.event === "agent_terminal_noisy_timeout");

      expect(noisyTimeoutLog).toMatchObject({
        event: "agent_terminal_noisy_timeout",
        chat_id: "chat-1",
        user_id: "u1",
        tool_call_id: "call-1",
        output_truncated: true,
        termination_attempted: true,
        termination_succeeded: true,
      });
      expect(noisyTimeoutLog?.pid).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("retains local command tracking when cancellation is not confirmed", async () => {
    const abortController = new AbortController();
    let commandStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      commandStarted = resolve;
    });
    const nonE2B = {
      sandboxKind: "centrifugo" as const,
      isWindows: () => false,
      commands: {
        run: jest.fn(
          async (
            _command: string,
            opts?: {
              signal?: AbortSignal;
              onCancelReady?: (cancel: () => Promise<boolean>) => void;
            },
          ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
            commandStarted();
            opts?.onCancelReady?.(async () => false);
            return new Promise(() => {});
          },
        ),
      },
    };
    const { context, ptySessionManager } = makeContext({ sandbox: nonE2B });
    const resultPromise = runTool(
      createRunTerminalCmd(context),
      {
        action: "exec",
        command: "sleep 999",
        brief: "wait",
        is_background: false,
        interactive: false,
        timeout: 30,
      },
      abortController.signal,
    ) as Promise<{
      result: { error?: string; exitCode?: number | null; session?: string };
    }>;

    await started;
    abortController.abort();
    const result = await resultPromise;

    expect(result.result.exitCode).toBeNull();
    expect(result.result.error).toContain(
      "Command cancellation could not be confirmed",
    );
    expect(result.result.session).toBeDefined();
    expect(
      ptySessionManager.get("chat-1", result.result.session!),
    ).toBeDefined();

    ptySessionManager.forget("chat-1", result.result.session!);
  });

  test("does not retry a foreground command after its tool timeout resolves", async () => {
    let rejectFirstAttempt!: (error: Error) => void;
    const firstAttempt = new Promise<never>((_resolve, reject) => {
      rejectFirstAttempt = reject;
    });
    const nonE2B = {
      sandboxKind: "centrifugo" as const,
      isWindows: () => false,
      commands: {
        run: jest.fn(() => firstAttempt),
      },
    };

    const { context } = makeContext({ sandbox: nonE2B });
    const tool = createRunTerminalCmd(context);
    const result = (await runTool(tool, {
      command: "whois hackerai.co",
      brief: "look up domain registration",
      is_background: false,
      timeout: 0.01,
    })) as { result: { timedOut?: boolean; session?: string } };

    expect(result.result.timedOut).toBe(true);
    expect(result.result.session).toMatch(/^[a-f0-9]{8}$/);
    rejectFirstAttempt(new Error("transient relay failure"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(nonE2B.commands.run).toHaveBeenCalledTimes(1);
  });

  test("logs sanitized agent-browser terminal usage to PostHog", async () => {
    const nonE2B = {
      sandboxKind: "centrifugo" as const,
      isWindows: () => false,
      commands: {
        run: jest.fn(
          async (_cmd: string, opts?: { onStdout?: (s: string) => void }) => {
            opts?.onStdout?.("opened\n");
            return { stdout: "opened\n", stderr: "", exitCode: 0 };
          },
        ),
      },
    };

    const { context } = makeContext({ sandbox: nonE2B });
    const tool = createRunTerminalCmd(context);

    await runTool(tool, {
      command:
        "agent-browser open https://secret.example/login && agent-browser screenshot",
      brief: "open a browser page",
      is_background: false,
      timeout: 5,
    });

    expect(mockPhEvent).toHaveBeenCalledWith(
      "agent_browser_terminal_command_used",
      expect.objectContaining({
        userId: "u1",
        chat_id: "chat-1",
        mode: "agent",
        subscription_tier: "pro",
        sandbox_type: "remote-connection",
        primary_action: "open",
        actions: ["open", "screenshot"],
        invocation_count: 2,
        used_via_npx: false,
        interactive: false,
        is_background: false,
        agent_browser_usage_event_version: 1,
      }),
    );
    expect(mockPhEvent.mock.calls[0]?.[1]).not.toHaveProperty("user_id");
    expect(mockPhEvent.mock.calls[0]?.[1]).not.toHaveProperty("subscription");
    expect(mockPhEvent.mock.calls[0]?.[1]).not.toHaveProperty(
      "configured_model",
    );
    expect(mockPhEvent.mock.calls[0]?.[1]).not.toHaveProperty("active_model");
    expect(JSON.stringify(mockPhEvent.mock.calls)).not.toContain(
      "secret.example",
    );
  });

  test("schema defaults action=exec and interactive=false when omitted", async () => {
    // A bare `{command}` must flow through the legacy path
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
    })) as { result: { session?: string; exitCode: number | null } };
    expect(result.result.session).toBeUndefined();
    expect(result.result.exitCode).toBe(0);
  });

  test("blocks non-interactive execution when a selected local sandbox falls back", async () => {
    const e2b = makeFakeE2BSandbox();
    const { context, sandboxManager, writerWrites } = makeContext({
      sandbox: e2b,
    });
    sandboxManager.consumeFallbackInfo.mockReturnValueOnce({
      occurred: true,
      reason: "no_local_connections",
      requestedPreference: "desktop",
      actualSandbox: "e2b",
      actualSandboxName: "Cloud",
    });
    const tool = createRunTerminalCmd(context);

    const result = (await runTool(tool, {
      command: "rm -rf ~/project",
      brief: "run command",
      is_background: false,
      timeout: 5,
    })) as { result: { error?: string; exitCode: number } };

    expect(e2b.commands.run).not.toHaveBeenCalled();
    expect(result.result.exitCode).toBe(1);
    expect(result.result.error).toContain(
      "HackerAI did not switch this run to Cloud",
    );
    expect(writerWrites).not.toContainEqual(
      expect.objectContaining({
        type: "data-sandbox-fallback",
      }),
    );
  });

  test("blocks interactive PTY creation when a selected local sandbox falls back", async () => {
    const e2b = makeFakeE2BSandbox();
    const { context, sandboxManager, writerWrites } = makeContext({
      sandbox: e2b,
    });
    sandboxManager.consumeFallbackInfo.mockReturnValueOnce({
      occurred: true,
      reason: "connection_unavailable",
      requestedPreference: "desktop",
      actualSandbox: "other-local",
      actualSandboxName: "Other Mac",
    });
    const tool = createRunTerminalCmd(context);

    const result = (await runTool(tool, {
      action: "exec",
      command: "sh",
      brief: "open shell",
      is_background: false,
      interactive: true,
      timeout: 1,
    })) as { result: { error?: string; exitCode: number } };

    expect(mockCreateE2BPtyHandle).not.toHaveBeenCalled();
    expect(result.result.exitCode).toBe(1);
    expect(result.result.error).toContain(
      "commands would run on the wrong host",
    );
    expect(writerWrites).not.toContainEqual(
      expect.objectContaining({
        type: "data-sandbox-fallback",
      }),
    );
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
      brief: "x",
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
      brief: "x",
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
      brief: "list",
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
      brief: "x",
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
      brief: "x",
      is_background: false,
      interactive: true,
    })) as { result: { error?: string } };

    expect(result.result.error).toMatch(/spawn failed/);
    expect(ptySessionManager.list("chat-1")).toEqual([]);
  });
});
