import {
  createTerminalRecordStore,
  TERMINAL_RECORD_RETENTION_MS,
  type TerminalExecutionRecord,
} from "../terminal-execution-record";
import { PtySessionManager, MAX_BUFFER_BYTES } from "../pty-session-manager";
import { createCommandSessionHandle } from "../command-session-handle";

function sandboxFixture() {
  const data = new Map<string, string>();
  const sandbox = {
    sandboxId: "sandbox-one",
    files: {
      write: jest.fn(async (path: string, contents: string) => {
        data.set(path, contents);
      }),
      read: jest.fn(async (path: string) => {
        if (!data.has(path)) throw new Error("missing");
        return data.get(path)!;
      }),
      list: jest.fn(async (path: string) =>
        [...data.keys()]
          .filter((p) => p.startsWith(path + "/"))
          .map((p) => ({ name: p.split("/").pop()! })),
      ),
      remove: jest.fn(async (path: string) => {
        data.delete(path);
      }),
    },
  };
  return { sandbox: sandbox as any, data };
}

function record(
  overrides: Partial<TerminalExecutionRecord> = {},
): TerminalExecutionRecord {
  return {
    version: 1,
    session: "abcdef12",
    sandboxInstance: "e2b:sandbox-one",
    command: "bounded test",
    pid: 123,
    status: "completed",
    exitCode: 0,
    exitReason: "process_exit",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    output: "final result",
    outputTruncated: false,
    artifactPaths: ["/tmp/result.json"],
    ...overrides,
  };
}

describe("terminal execution records", () => {
  it("recovers in a fresh store and isolates user, scope, and sandbox instance", async () => {
    const { sandbox } = sandboxFixture();
    const store = createTerminalRecordStore(sandbox, "user-one", "chat-one");
    await store.save(record());
    expect(
      await createTerminalRecordStore(sandbox, "user-one", "chat-one").read(
        "abcdef12",
      ),
    ).toMatchObject({ output: "final result", exitCode: 0 });
    expect(
      await createTerminalRecordStore(sandbox, "user-two", "chat-one").read(
        "abcdef12",
      ),
    ).toBeNull();
    expect(
      await createTerminalRecordStore(sandbox, "user-one", "chat-two").read(
        "abcdef12",
      ),
    ).toBeNull();
    expect(
      await createTerminalRecordStore(
        { ...sandbox, sandboxId: "sandbox-two" },
        "user-one",
        "chat-one",
      ).read("abcdef12"),
    ).toBeNull();
    expect(await store.read("../../other")).toBeNull();
  });

  it("rejects torn, expired, and mismatched records", async () => {
    const { sandbox, data } = sandboxFixture();
    const store = createTerminalRecordStore(sandbox, "u", "c");
    data.set(store.pathFor("abcdef12"), "{");
    expect(await store.read("abcdef12")).toBeNull();
    await store.save(
      record({ updatedAt: Date.now() - TERMINAL_RECORD_RETENTION_MS - 1 }),
    );
    expect(await store.read("abcdef12")).toBeNull();
    await store.save(record({ sandboxInstance: "e2b:another" }));
    expect(await store.read("abcdef12")).toBeNull();
  });

  it("bounds retained records and ignores foreign files", async () => {
    const { sandbox, data } = sandboxFixture();
    const store = createTerminalRecordStore(sandbox, "u", "c");
    for (let i = 0; i < 70; i++)
      await store.save(
        record({
          session: i.toString(16).padStart(8, "0"),
          updatedAt: Date.now() - i,
        }),
      );
    const foreign = store
      .pathFor("abcdef12")
      .replace("abcdef12.json", "user-file.txt");
    data.set(foreign, "keep me");
    await store.prune();
    expect([...data.keys()].filter((p) => p.endsWith(".json"))).toHaveLength(
      64,
    );
    expect(data.get(foreign)).toBe("keep me");
  });

  it("retains the tail of an oversized chunk and the final exit after handle removal", async () => {
    const { sandbox } = sandboxFixture();
    const store = createTerminalRecordStore(sandbox, "u", "c");
    const manager = new PtySessionManager();
    const handle = createCommandSessionHandle({ kill: async () => true });
    const session = await manager.create("c", {
      createHandle: async () => handle,
      cols: 120,
      rows: 30,
      kind: "command",
      sandboxIdentity: "e2b",
      originalCommand: "bounded test",
      executionRecord: {
        ...store,
        sandboxInstance: "e2b:sandbox-one",
        artifactPaths: ["/tmp/partial.json"],
      },
    });
    handle.setPid(123);
    handle.emitText("x".repeat(MAX_BUFFER_BYTES + 100) + "FINAL_EVIDENCE");
    handle.resolveExit(0);
    await Promise.resolve();
    await manager.forget("c", session.sessionId);
    expect(manager.get("c", session.sessionId)).toBeUndefined();
    const saved = await store.read(session.sessionId);
    expect(saved).toMatchObject({
      status: "completed",
      exitCode: 0,
      pid: 123,
      outputTruncated: true,
      artifactPaths: ["/tmp/partial.json"],
    });
    expect(saved?.output).toHaveLength(MAX_BUFFER_BYTES);
    expect(saved?.output.endsWith("FINAL_EVIDENCE")).toBe(true);
  });

  it("distinguishes cancellation from completion while retaining partial evidence", async () => {
    const { sandbox } = sandboxFixture();
    const store = createTerminalRecordStore(sandbox, "u", "c");
    const kill = jest.fn(async () => true);
    const handle = createCommandSessionHandle({ kill });
    const manager = new PtySessionManager();
    const session = await manager.create("c", {
      createHandle: async () => handle,
      cols: 120,
      rows: 30,
      kind: "command",
      sandboxIdentity: "e2b",
      originalCommand: "bounded test",
      executionRecord: {
        ...store,
        sandboxInstance: "e2b:sandbox-one",
        artifactPaths: [],
      },
    });
    handle.emitText("partial evidence");
    await manager.close("c", session.sessionId);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(await store.read(session.sessionId)).toMatchObject({
      status: "stopped",
      exitReason: "user_cancelled",
      output: "partial evidence",
    });
  });

  it("reports persistence failure without failing command execution", async () => {
    const { sandbox } = sandboxFixture();
    sandbox.files.write.mockRejectedValue(new Error("offline"));
    expect(
      await createTerminalRecordStore(sandbox, "u", "c").save(record()),
    ).toBeNull();
  });

  it("does not delay cancellation on slow persistence and coalesces the final state", async () => {
    jest.useFakeTimers();
    let release!: () => void;
    const slowWrite = new Promise<void>((resolve) => {
      release = resolve;
    });
    const saved: TerminalExecutionRecord[] = [];
    const save = jest.fn(async (value: TerminalExecutionRecord) => {
      saved.push(value);
      if (saved.length === 1) await slowWrite;
      return "/tmp/receipt.json";
    });
    const kill = jest.fn(async () => true);
    const handle = createCommandSessionHandle({ kill });
    const manager = new PtySessionManager();
    try {
      const session = await manager.create("c", {
        createHandle: async () => handle,
        cols: 120,
        rows: 30,
        kind: "command",
        sandboxIdentity: "e2b",
        originalCommand: "test",
        executionRecord: {
          sandboxInstance: "e2b:one",
          artifactPaths: [],
          save,
          prune: async () => {},
        },
      });
      handle.emitText("partial evidence");
      const closing = manager.close("c", session.sessionId);
      expect(kill).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(2100);
      await closing;
      expect(session.recordPersistenceFailed).toBe(true);
      release();
      await jest.advanceTimersByTimeAsync(0);
      expect(saved.at(-1)).toMatchObject({
        status: "stopped",
        exitReason: "user_cancelled",
        output: "partial evidence",
      });
      expect(save.mock.calls.length).toBeLessThanOrEqual(2);
    } finally {
      release();
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });
});
