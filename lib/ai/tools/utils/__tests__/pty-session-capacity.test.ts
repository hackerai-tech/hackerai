import {
  PtySessionManager,
  MAX_CONCURRENT_PTYS_PER_CHAT,
} from "../pty-session-manager";
import type { PtyHandle } from "../e2b-pty-adapter";
import type { TerminalExecutionRecord } from "../terminal-execution-record";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function handle() {
  const exit = deferred<{
    exitCode: number | null;
    observationFailed?: true;
  }>();
  const child: PtyHandle = {
    pid: 42,
    exited: exit.promise,
    onData: () => () => {},
    sendInput: jest.fn(),
    resize: jest.fn(),
    kill: jest.fn(async () => {
      exit.resolve({ exitCode: 0 });
    }),
  };
  return { child, exit };
}
const options = (createHandle: () => Promise<PtyHandle>) => ({
  createHandle,
  cols: 80,
  rows: 24,
  sandboxIdentity: "e2b" as const,
  originalCommand: "fixture",
});

describe("terminal capacity ownership", () => {
  let manager: PtySessionManager;
  beforeEach(() => {
    manager = new PtySessionManager();
  });
  afterEach(async () => {
    await manager.closeAll("chat");
  });

  it("reuses confirmed-exit capacity while retaining bounded history and every persisted exit", async () => {
    const records = new Map<string, TerminalExecutionRecord>();
    const sessions = [];
    for (let i = 0; i < 24; i++) {
      const { child, exit } = handle();
      const session = await manager.create("chat", {
        ...options(async () => child),
        executionRecord: {
          sandboxInstance: "fixture",
          artifactPaths: [],
          prune: async () => {},
          save: async (record) => {
            records.set(record.session, record);
            return "/record/" + record.session;
          },
        },
      });
      exit.resolve({ exitCode: 7 });
      await child.exited;
      await manager.checkpoint(session);
      sessions.push(session);
      expect(child.kill).not.toHaveBeenCalled();
    }
    expect(manager.list("chat").length).toBeLessThanOrEqual(
      MAX_CONCURRENT_PTYS_PER_CHAT,
    );
    expect(manager.get("chat", sessions.at(-1)!.sessionId)).toBe(
      sessions.at(-1),
    );
    expect(records.size).toBe(24);
    expect(
      [...records.values()].every(
        (r) => r.exitCode === 7 && r.status === "failed",
      ),
    ).toBe(true);
  });

  it("reserves slots before concurrent factories resolve and releases rejected creation", async () => {
    const gates = Array.from({ length: 10 }, () => deferred<PtyHandle>());
    const pending = gates.map((gate) =>
      manager.create(
        "chat",
        options(() => gate.promise),
      ),
    );
    const overflow = jest.fn(async () => handle().child);
    await expect(manager.create("chat", options(overflow))).rejects.toThrow(
      "MAX_CONCURRENT",
    );
    expect(overflow).not.toHaveBeenCalled();
    const failure = expect(pending[0]).rejects.toThrow("spawn failed");
    gates[0].reject(new Error("spawn failed"));
    await failure;
    for (const gate of gates.slice(1)) gate.resolve(handle().child);
    await Promise.all(pending.slice(1));
    await expect(
      manager.create("chat", options(overflow)),
    ).resolves.toBeDefined();
    expect(overflow).toHaveBeenCalledTimes(1);
  });

  it("drains creation already admitted at shutdown without closing a later response", async () => {
    const gate = deferred<PtyHandle>();
    const before = handle();
    const after = handle();
    const pending = manager.create(
      "chat",
      options(() => gate.promise),
    );
    const drain = manager.closeAll("chat");
    const later = await manager.create(
      "chat",
      options(async () => after.child),
    );
    gate.resolve(before.child);
    const earlier = await pending;
    await drain;
    expect(before.child.kill).toHaveBeenCalledTimes(1);
    expect(manager.get("chat", earlier.sessionId)).toBeUndefined();
    expect(after.child.kill).not.toHaveBeenCalled();
    expect(manager.get("chat", later.sessionId)).toBe(later);
  });

  it("does not release capacity merely because the exit observation rejects", async () => {
    for (let i = 0; i < 10; i++) {
      const { child, exit } = handle();
      await manager.create(
        "chat",
        options(async () => child),
      );
      exit.reject(new Error("observation unavailable"));
      await Promise.resolve();
    }
    const factory = jest.fn(async () => handle().child);
    await expect(manager.create("chat", options(factory))).rejects.toThrow(
      "MAX_CONCURRENT",
    );
    expect(factory).not.toHaveBeenCalled();
  });
  it("retains failed observations for cleanup while confirmed null exits release capacity", async () => {
    const uncertain = handle();
    const owned = await manager.create(
      "chat",
      options(async () => uncertain.child),
    );
    uncertain.exit.resolve({ exitCode: null, observationFailed: true });
    for (let i = 0; i < 24; i++) {
      const current = handle();
      const session = await manager.create(
        "chat",
        options(async () => current.child),
      );
      current.exit.resolve({ exitCode: null });
      await current.child.exited;
      await manager.checkpoint(session);
    }
    expect(manager.get("chat", owned.sessionId)).toBe(owned);
    await manager.closeAll("chat");
    expect(uncertain.child.kill).toHaveBeenCalledTimes(1);
  });
});
