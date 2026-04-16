/**
 * Tests for the E2B PTY adapter.
 *
 * Wraps E2B's callback-style `sandbox.pty.create({onData, cols, rows, ...})`
 * into a listener-set based `PtyHandle`. Verifies:
 * - correct propagation of options to `sandbox.pty.create`
 * - fan-out of `onData` chunks to multiple listeners
 * - unsubscribe removes the listener from future deliveries
 * - `sendInput`/`resize`/`kill` delegate with the captured pid
 * - `exited` is a memoized promise resolving once with `{exitCode}`
 *   (or `{exitCode: null}` if `wait()` rejects, with a logged error)
 */

import type { Sandbox } from "@e2b/code-interpreter";
import { createE2BPtyHandle, type CreatePtyOptions } from "../e2b-pty-adapter";

// ── Mock helpers ─────────────────────────────────────────────────────

type OnDataCb = (bytes: Uint8Array) => void | Promise<void>;

interface CapturedCreateCall {
  cols: number;
  rows: number;
  cwd?: string;
  envs?: Record<string, string>;
  onData: OnDataCb;
}

interface MockHandle {
  pid: number;
  wait: jest.Mock<Promise<{ exitCode: number }>>;
}

interface MockPtyCalls {
  capturedCreate: CapturedCreateCall | null;
  sendInput: jest.Mock;
  resize: jest.Mock;
  kill: jest.Mock;
  create: jest.Mock;
}

interface MockSandboxResult {
  sandbox: Sandbox;
  mock: MockPtyCalls;
  emitData: (bytes: Uint8Array) => Promise<void>;
  resolveWait: (result: { exitCode: number }) => void;
  rejectWait: (err: Error) => void;
}

function buildMockSandbox(pid = 4242): MockSandboxResult {
  const mock: MockPtyCalls = {
    capturedCreate: null,
    sendInput: jest.fn().mockResolvedValue(undefined),
    resize: jest.fn().mockResolvedValue(undefined),
    kill: jest.fn().mockResolvedValue(true),
    create: jest.fn(),
  };

  let resolveWait!: (result: { exitCode: number }) => void;
  let rejectWait!: (err: Error) => void;
  const waitPromise = new Promise<{ exitCode: number }>((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject;
  });

  const handle: MockHandle = {
    pid,
    wait: jest.fn(() => waitPromise),
  };

  mock.create.mockImplementation(async (opts: CapturedCreateCall) => {
    mock.capturedCreate = opts;
    return handle;
  });

  const sandboxLike = {
    pty: {
      create: mock.create,
      sendInput: mock.sendInput,
      resize: mock.resize,
      kill: mock.kill,
    },
  };

  return {
    sandbox: sandboxLike as unknown as Sandbox,
    mock,
    emitData: async (bytes) => {
      if (!mock.capturedCreate) {
        throw new Error(
          "onData not captured yet — call createE2BPtyHandle first",
        );
      }
      await mock.capturedCreate.onData(bytes);
    },
    resolveWait,
    rejectWait,
  };
}

const defaultOpts: CreatePtyOptions = { cols: 120, rows: 30 };

// ── Tests ────────────────────────────────────────────────────────────

describe("createE2BPtyHandle", () => {
  it("calls sandbox.pty.create with cols/rows/cwd/envs and attaches an onData callback", async () => {
    const { sandbox, mock } = buildMockSandbox();
    const opts: CreatePtyOptions = {
      cols: 80,
      rows: 24,
      cwd: "/workspace",
      envs: { FOO: "bar" },
    };

    const handle = await createE2BPtyHandle(sandbox, opts);

    expect(handle.pid).toBe(4242);
    expect(mock.create).toHaveBeenCalledTimes(1);
    const created = mock.capturedCreate;
    expect(created).not.toBeNull();
    expect(created!.cols).toBe(80);
    expect(created!.rows).toBe(24);
    expect(created!.cwd).toBe("/workspace");
    expect(created!.envs).toEqual({ FOO: "bar" });
    expect(typeof created!.onData).toBe("function");
  });

  it("fans out onData chunks from E2B to every registered listener", async () => {
    const { sandbox, emitData } = buildMockSandbox();
    const handle = await createE2BPtyHandle(sandbox, defaultOpts);

    const a = jest.fn();
    const b = jest.fn();
    const c = jest.fn();
    handle.onData(a);
    handle.onData(b);
    handle.onData(c);

    const chunk = new Uint8Array([1, 2, 3]);
    await emitData(chunk);

    expect(a).toHaveBeenCalledWith(chunk);
    expect(b).toHaveBeenCalledWith(chunk);
    expect(c).toHaveBeenCalledWith(chunk);
  });

  it("returned unsubscribe function stops delivery to that listener only", async () => {
    const { sandbox, emitData } = buildMockSandbox();
    const handle = await createE2BPtyHandle(sandbox, defaultOpts);

    const keep = jest.fn();
    const drop = jest.fn();
    handle.onData(keep);
    const unsub = handle.onData(drop);

    await emitData(new Uint8Array([0x41]));
    expect(keep).toHaveBeenCalledTimes(1);
    expect(drop).toHaveBeenCalledTimes(1);

    unsub();

    await emitData(new Uint8Array([0x42]));
    expect(keep).toHaveBeenCalledTimes(2);
    expect(drop).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe is idempotent (calling twice does not throw or affect others)", async () => {
    const { sandbox, emitData } = buildMockSandbox();
    const handle = await createE2BPtyHandle(sandbox, defaultOpts);

    const keep = jest.fn();
    const drop = jest.fn();
    handle.onData(keep);
    const unsub = handle.onData(drop);

    unsub();
    expect(() => unsub()).not.toThrow();

    await emitData(new Uint8Array([7]));
    expect(keep).toHaveBeenCalledTimes(1);
    expect(drop).not.toHaveBeenCalled();
  });

  it("sendInput delegates to sandbox.pty.sendInput with the captured pid", async () => {
    const { sandbox, mock } = buildMockSandbox(9999);
    const handle = await createE2BPtyHandle(sandbox, defaultOpts);

    const payload = new Uint8Array([0x65, 0x78, 0x69, 0x74]); // "exit"
    await handle.sendInput(payload);

    expect(mock.sendInput).toHaveBeenCalledTimes(1);
    expect(mock.sendInput).toHaveBeenCalledWith(9999, payload);
  });

  it("resize delegates to sandbox.pty.resize with the captured pid and size object", async () => {
    const { sandbox, mock } = buildMockSandbox(1234);
    const handle = await createE2BPtyHandle(sandbox, defaultOpts);

    await handle.resize(80, 24);

    expect(mock.resize).toHaveBeenCalledTimes(1);
    expect(mock.resize).toHaveBeenCalledWith(1234, { cols: 80, rows: 24 });
  });

  it("kill delegates to sandbox.pty.kill with the captured pid", async () => {
    const { sandbox, mock } = buildMockSandbox(5555);
    const handle = await createE2BPtyHandle(sandbox, defaultOpts);

    await handle.kill();

    expect(mock.kill).toHaveBeenCalledTimes(1);
    expect(mock.kill).toHaveBeenCalledWith(5555);
  });

  it("exited resolves with {exitCode: 0} when wait() resolves with 0", async () => {
    const { sandbox, resolveWait } = buildMockSandbox();
    const handle = await createE2BPtyHandle(sandbox, defaultOpts);

    resolveWait({ exitCode: 0 });

    await expect(handle.exited).resolves.toEqual({ exitCode: 0 });
  });

  it("exited resolves with the reported non-zero exit code", async () => {
    const { sandbox, resolveWait } = buildMockSandbox();
    const handle = await createE2BPtyHandle(sandbox, defaultOpts);

    resolveWait({ exitCode: 137 });

    await expect(handle.exited).resolves.toEqual({ exitCode: 137 });
  });

  it("exited resolves with {exitCode: null} and logs when wait() rejects", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { sandbox, rejectWait } = buildMockSandbox();
      const handle = await createE2BPtyHandle(sandbox, defaultOpts);

      rejectWait(new Error("boom"));

      await expect(handle.exited).resolves.toEqual({ exitCode: null });
      expect(errorSpy).toHaveBeenCalled();
      const firstCall = errorSpy.mock.calls[0];
      expect(String(firstCall[0])).toContain("[e2b-pty-adapter]");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("exited is memoized — every await returns the same resolution", async () => {
    const { sandbox, resolveWait } = buildMockSandbox();
    const handle = await createE2BPtyHandle(sandbox, defaultOpts);

    resolveWait({ exitCode: 0 });

    const [a, b, c] = await Promise.all([
      handle.exited,
      handle.exited,
      handle.exited,
    ]);
    expect(a).toEqual({ exitCode: 0 });
    expect(b).toBe(a);
    expect(c).toBe(a);
    // handle.exited is the same Promise instance across accesses
    expect(handle.exited).toBe(handle.exited);
  });

  it("kicks off wait() eagerly inside createE2BPtyHandle (not deferred to first access)", async () => {
    const { sandbox, mock } = buildMockSandbox();
    await createE2BPtyHandle(sandbox, defaultOpts);

    // The mock handle's `wait` is invoked by the adapter as soon as it's
    // wired up — before any consumer touches `.exited`.
    // Read through the captured handle via the create mock's resolved value.
    // We verify indirectly: the adapter memoizes from a single wait() call,
    // so wait should have been called exactly once by creation time.
    const handleReturn = await mock.create.mock.results[0].value;
    const mockHandle = handleReturn as MockHandle;
    expect(mockHandle.wait).toHaveBeenCalledTimes(1);
  });
});
