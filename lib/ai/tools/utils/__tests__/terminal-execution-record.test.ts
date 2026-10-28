import {
  createTerminalRecordStore,
  terminalSandboxInstance,
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
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("separates cloud from local and preserves local environment identity across relay reconnects", async () => {
    const { sandbox } = sandboxFixture();
    expect(terminalSandboxInstance(sandbox)).toBe("e2b:sandbox-one");
    const local = {
      ...sandbox,
      sandboxKind: "centrifugo",
      getConnectionId: () => "relay-one",
      isWindows: () => false,
      supportsNativeFileRelay: () => true,
      getConnectionInfo: () => ({
        connectionId: "relay-one",
        environmentId: "installation-one",
        isDesktop: true,
      }),
    };
    const localRecord = record({
      sandboxInstance: terminalSandboxInstance(local),
    });
    await createTerminalRecordStore(local, "u", "reconnect").save(localRecord);
    const reconnected = {
      ...local,
      getConnectionId: () => "relay-two",
      getConnectionInfo: () => ({
        connectionId: "relay-two",
        environmentId: "installation-one",
        isDesktop: true,
      }),
    };
    expect(
      await createTerminalRecordStore(reconnected, "u", "reconnect").read(
        "abcdef12",
      ),
    ).toMatchObject({ status: "completed" });
    expect(
      await createTerminalRecordStore(sandbox, "u", "reconnect").read(
        "abcdef12",
      ),
    ).toBeNull();
  });
  it.each([
    ["/Users/test/Selected project", false],
    ["C:/Users/test/Selected project", true],
  ])(
    "persists and recovers Desktop records inside %s",
    async (project, windows) => {
      const { sandbox, data } = sandboxFixture();
      const local = {
        ...sandbox,
        sandboxKind: "centrifugo" as const,
        getConnectionId: () => "desktop-scoped",
        getWorkingDirectory: () => project,
        isWindows: () => windows,
        supportsNativeFileRelay: () => true,
      };
      // Model the native file API's selected-project boundary, not a permissive map.
      sandbox.files.write.mockImplementation(
        async (path: string, content: string) => {
          if (!path.startsWith(project + "/"))
            throw new Error("outside allowed root");
          data.set(path, content);
        },
      );
      const store = createTerminalRecordStore(local, "u", "scoped-project");
      const saved = await store.save(
        record({ sandboxInstance: terminalSandboxInstance(local) }),
      );
      expect(saved).not.toBeNull();
      expect(
        await createTerminalRecordStore(local, "u", "scoped-project").read(
          "abcdef12",
        ),
      ).toMatchObject({ output: "final result", status: "completed" });
      expect([...data.keys()][0]).toContain(
        `${project}/.hackerai/terminal_execution_records/`,
      );
    },
  );

  it("does not retransmit unchanged output when polling, but persists changes and retries failures", async () => {
    const { sandbox } = sandboxFixture();
    const store = createTerminalRecordStore(sandbox, "u", "polling");
    const handle = createCommandSessionHandle({ kill: async () => true });
    const manager = new PtySessionManager();
    const session = await manager.create("polling", {
      createHandle: async () => handle,
      cols: 120,
      rows: 30,
      kind: "command",
      sandboxIdentity: "e2b",
      originalCommand: "bounded test",
      executionRecord: {
        ...store,
        checkpointOnStart: false,
        pruneOnStart: false,
        sandboxInstance: "e2b:sandbox-one",
        artifactPaths: [],
      },
    });
    try {
      handle.emitText("x".repeat(MAX_BUFFER_BYTES));
      await manager.checkpoint(session);
      const initialBytes = sandbox.files.write.mock.calls.reduce(
        (bytes: number, call: [string, string]) =>
          bytes + Buffer.byteLength(call[1]),
        0,
      );
      for (let i = 0; i < 10; i++) await manager.checkpoint(session);
      expect(
        sandbox.files.write.mock.calls.reduce(
          (bytes: number, call: [string, string]) =>
            bytes + Buffer.byteLength(call[1]),
          0,
        ),
      ).toBe(initialBytes);
      handle.emitText("new evidence");
      sandbox.files.write.mockRejectedValueOnce(new Error("offline"));
      await manager.checkpoint(session);
      expect(session.recordPersistenceFailed).toBe(true);
      await manager.checkpoint(session);
      expect(session.recordPersistenceFailed).toBe(false);
      expect(
        (await store.read(session.sessionId))?.output.endsWith("new evidence"),
      ).toBe(true);
      session.outputPath = "/tmp/new-artifact.txt";
      await manager.checkpoint(session);
      expect((await store.read(session.sessionId))?.artifactPaths).toContain(
        "/tmp/new-artifact.txt",
      );
      await manager.close("polling", session.sessionId);
      expect(await store.read(session.sessionId)).toMatchObject({
        status: "stopped",
        exitReason: "user_cancelled",
      });
    } finally {
      await manager.closeAll("polling");
    }
  });

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

  it.each([false, true])(
    "bounds Windows retention I/O and preserves the retained set (timestamp ties: %s)",
    async (tied) => {
      const { sandbox, data } = sandboxFixture();
      Object.assign(sandbox, {
        sandboxKind: "centrifugo",
        getConnectionId: () => "windows-retention",
        isWindows: () => true,
      });
      const store = createTerminalRecordStore(
        sandbox,
        "u",
        `bounded-retention-${tied}`,
      );
      const now = Date.now();
      for (let i = 0; i < 80; i++) {
        await store.save(
          record({
            session: i.toString(16).padStart(8, "0"),
            sandboxInstance: terminalSandboxInstance(sandbox),
            updatedAt: tied ? now + (i === 79 ? 1 : 0) : now + i,
          }),
        );
      }
      let releaseReads!: () => void;
      const readGate = new Promise<void>((resolve) => {
        releaseReads = resolve;
      });
      let firstRead!: () => void;
      const readStarted = new Promise<void>((resolve) => {
        firstRead = resolve;
      });
      let activeReads = 0;
      let peakReads = 0;
      sandbox.files.read.mockImplementation(async (path: string) => {
        peakReads = Math.max(peakReads, ++activeReads);
        firstRead();
        await readGate;
        if (Number.parseInt(path.split("/").pop()!, 16) % 4 === 0)
          await Promise.resolve();
        try {
          return data.get(path)!;
        } finally {
          activeReads--;
        }
      });
      let activeRemovals = 0;
      let peakRemovals = 0;
      sandbox.files.remove.mockImplementation(async (path: string) => {
        peakRemovals = Math.max(peakRemovals, ++activeRemovals);
        await Promise.resolve();
        data.delete(path);
        activeRemovals--;
      });

      const pruning = store.prune();
      await readStarted;
      releaseReads();
      await pruning;

      expect(peakReads).toBeLessThanOrEqual(4);
      expect(peakRemovals).toBeLessThanOrEqual(4);
      expect(sandbox.files.read).toHaveBeenCalledTimes(80);
      expect([...data.keys()].sort()).toEqual(
        Array.from({ length: 64 }, (_, i) =>
          store.pathFor(
            (tied ? (i === 63 ? 79 : i) : i + 16).toString(16).padStart(8, "0"),
          ),
        ).sort(),
      );
    },
  );

  it("shares the retention I/O budget across different record directories", async () => {
    const { sandbox, data } = sandboxFixture();
    Object.assign(sandbox, {
      sandboxKind: "centrifugo",
      getConnectionId: () => "shared-windows-retention",
      isWindows: () => true,
    });
    const stores = ["first-retention", "second-retention"].map((scope) =>
      createTerminalRecordStore(sandbox, "u", scope),
    );
    for (const store of stores) {
      for (let i = 0; i < 12; i++) {
        await store.save(
          record({
            session: i.toString(16).padStart(8, "0"),
            sandboxInstance: terminalSandboxInstance(sandbox),
          }),
        );
      }
    }
    let releaseReads!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    let firstRead!: () => void;
    const started = new Promise<void>((resolve) => {
      firstRead = resolve;
    });
    let active = 0;
    let peak = 0;
    sandbox.files.read.mockImplementation(async (path: string) => {
      peak = Math.max(peak, ++active);
      firstRead();
      await gate;
      try {
        return data.get(path)!;
      } finally {
        active--;
      }
    });
    const passes = stores.map((store) => store.prune());
    await started;
    releaseReads();
    await Promise.all(passes);
    expect(peak).toBeLessThanOrEqual(4);
    expect(sandbox.files.read).toHaveBeenCalledTimes(24);
    expect(data.size).toBe(24);
  });

  it("keeps the directory guarded until a failed removal batch has fully settled", async () => {
    jest.useFakeTimers();
    const { sandbox, data } = sandboxFixture();
    Object.assign(sandbox, {
      sandboxKind: "centrifugo",
      getConnectionId: () => "failed-removal-retention",
      isWindows: () => true,
    });
    const store = createTerminalRecordStore(
      sandbox,
      "u",
      "failed-removal-retention",
    );
    for (let i = 0; i < 70; i++) {
      await store.save(
        record({
          session: i.toString(16).padStart(8, "0"),
          sandboxInstance: terminalSandboxInstance(sandbox),
          updatedAt: Date.now() + i,
        }),
      );
    }
    let releaseRemovals!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseRemovals = resolve;
    });
    let pendingRemoval!: () => void;
    const started = new Promise<void>((resolve) => {
      pendingRemoval = resolve;
    });
    let removalCalls = 0;
    sandbox.files.remove.mockImplementation(async (path: string) => {
      if (++removalCalls === 1) throw new Error("temporary removal failure");
      pendingRemoval();
      await gate;
      data.delete(path);
    });
    let settled = false;
    const first = store.prune().then(() => {
      settled = true;
    });
    await started;
    await jest.advanceTimersByTimeAsync(61_000);
    const settledBeforeRelease = settled;
    const second = createTerminalRecordStore(
      sandbox,
      "u",
      "failed-removal-retention",
    ).prune();
    await jest.advanceTimersByTimeAsync(0);
    const listingsBeforeRelease = sandbox.files.list.mock.calls.length;
    releaseRemovals();
    await Promise.all([first, second]);
    expect(settledBeforeRelease).toBe(false);
    expect(listingsBeforeRelease).toBe(1);
  });

  it("does not overlap a slow retention pass across stores and releases the guard after failure", async () => {
    jest.useFakeTimers();
    const { sandbox, data } = sandboxFixture();
    Object.assign(sandbox, {
      sandboxKind: "centrifugo",
      getConnectionId: () => "slow-windows-retention",
      isWindows: () => true,
    });
    const store = createTerminalRecordStore(sandbox, "u", "slow-retention");
    await store.save(
      record({ sandboxInstance: terminalSandboxInstance(sandbox) }),
    );
    const originalList = sandbox.files.list.getMockImplementation()!;
    let releaseListing!: () => void;
    const listingGate = new Promise<void>((resolve) => {
      releaseListing = resolve;
    });
    let firstList!: () => void;
    const listingStarted = new Promise<void>((resolve) => {
      firstList = resolve;
    });
    sandbox.files.list.mockImplementation(async () => {
      firstList();
      await listingGate;
      throw new Error("temporary listing failure");
    });
    const first = store.prune();
    await listingStarted;
    jest.setSystemTime(Date.now() + 61_000);
    const second = createTerminalRecordStore(
      sandbox,
      "u",
      "slow-retention",
    ).prune();
    await Promise.resolve();
    releaseListing();
    await Promise.all([first, second]);
    expect(sandbox.files.list).toHaveBeenCalledTimes(1);
    expect(data.size).toBe(1);

    sandbox.files.list.mockImplementation(originalList);
    jest.setSystemTime(Date.now() + 61_000);
    await store.prune();
    expect(sandbox.files.list).toHaveBeenCalledTimes(2);
    expect(data.size).toBe(1);
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

  it("periodically restores a quiet record removed by retention", async () => {
    jest.useFakeTimers();
    const { sandbox, data } = sandboxFixture();
    const store = createTerminalRecordStore(sandbox, "u", "quiet-record");
    const handle = createCommandSessionHandle({ kill: async () => true });
    const manager = new PtySessionManager();
    const session = await manager.create("quiet-record", {
      createHandle: async () => handle,
      cols: 120,
      rows: 30,
      kind: "command",
      sandboxIdentity: "e2b",
      originalCommand: "bounded test",
      executionRecord: {
        ...store,
        checkpointOnStart: false,
        pruneOnStart: false,
        sandboxInstance: "e2b:sandbox-one",
        artifactPaths: [],
      },
    });
    try {
      await manager.checkpoint(session);
      data.delete(store.pathFor(session.sessionId));
      await jest.advanceTimersByTimeAsync(60_000);
      await manager.checkpoint(session);
      expect(await store.read(session.sessionId)).toMatchObject({
        status: "running",
        updatedAt: Date.now(),
      });
    } finally {
      await manager.closeAll("quiet-record");
    }
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
