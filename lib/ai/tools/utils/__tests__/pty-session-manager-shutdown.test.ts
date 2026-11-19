import { PtySessionManager } from "../pty-session-manager";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe("terminal record work at response shutdown", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("does not abort or wait for a later response on the same chat", async () => {
    const manager = new PtySessionManager();
    const firstReceipt = deferred();
    const laterReceipt = deferred();
    let laterSignal: AbortSignal | undefined;
    const create = (prune: (signal?: AbortSignal) => Promise<void>) =>
      manager.create("same-chat", {
        createHandle: async () => ({
          pid: 123,
          onData: () => () => {},
          exited: Promise.resolve({ exitCode: 0 }),
          kill: async () => {},
          sendInput: async () => {},
          resize: async () => {},
        }),
        cols: 120,
        rows: 30,
        kind: "command",
        sandboxIdentity: "e2b",
        originalCommand: "printf QA",
        executionRecord: {
          sandboxInstance: "qa",
          artifactPaths: [],
          save: async () => "/qa/record.json",
          prune,
        },
      });
    const first = await create(async () => firstReceipt.promise);
    await manager.forget("same-chat", first.sessionId);
    let done = false;
    const shutdown = manager.closeAll("same-chat").then(() => {
      done = true;
    });
    const duplicateShutdown = manager.closeAll("same-chat");
    const later = await create(async (signal) => {
      laterSignal = signal;
      await laterReceipt.promise;
    });
    firstReceipt.resolve();
    await jest.advanceTimersByTimeAsync(10);
    expect(done).toBe(true);
    expect(laterSignal?.aborted).toBe(false);
    await shutdown;
    await duplicateShutdown;
    laterReceipt.resolve();
    await manager.forget("same-chat", later.sessionId);
    await manager.closeAll("same-chat");
  });

  it("keeps the receiver alive for retention started by an already forgotten command", async () => {
    const manager = new PtySessionManager();
    const retentionReceipt = deferred();
    const dispatch = jest.fn();
    const createHandle = jest.fn(async () => ({
      pid: 123,
      onData: () => () => {},
      exited: Promise.resolve({ exitCode: 0 }),
      kill: jest.fn(async () => {}),
      sendInput: jest.fn(async () => {}),
      resize: jest.fn(async () => {}),
    }));
    const session = await manager.create("shutdown", {
      createHandle,
      cols: 120,
      rows: 30,
      kind: "command",
      sandboxIdentity: "e2b",
      originalCommand: "printf QA",
      executionRecord: {
        sandboxInstance: "qa",
        artifactPaths: [],
        save: async () => "/qa/record.json",
        prune: async () => {
          dispatch();
          await retentionReceipt.promise;
        },
      },
    });
    await manager.forget("shutdown", session.sessionId);
    expect(manager.list("shutdown")).toHaveLength(0);
    // Retention owns separate transport work, not a pending record checkpoint.
    expect(
      await manager.waitForPendingRecord("shutdown", session.sessionId),
    ).toBe(false);
    let workerFinished = false;
    const shutdown = manager.closeAll("shutdown").then(() => {
      workerFinished = true;
    });
    await jest.advanceTimersByTimeAsync(10);
    expect(workerFinished).toBe(false);
    retentionReceipt.resolve();
    await shutdown;
    expect(workerFinished).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(createHandle).toHaveBeenCalledTimes(1);
  });

  it("drains a checkpoint after the short tool wait has expired and the session was forgotten", async () => {
    const manager = new PtySessionManager();
    const receipt = deferred();
    const save = jest.fn(async () => {
      await receipt.promise;
      return "/qa/record.json";
    });
    const session = await manager.create("checkpoint", {
      createHandle: async () => ({
        pid: 456,
        onData: () => () => {},
        exited: Promise.resolve({ exitCode: 0 }),
        kill: async () => {},
        sendInput: async () => {},
        resize: async () => {},
      }),
      cols: 120,
      rows: 30,
      kind: "command",
      sandboxIdentity: "e2b",
      originalCommand: "printf QA",
      executionRecord: {
        sandboxInstance: "qa",
        artifactPaths: [],
        save,
        prune: async () => {},
        checkpointOnStart: false,
      },
    });
    const forget = manager.forget("checkpoint", session.sessionId);
    await jest.advanceTimersByTimeAsync(2001);
    await forget;
    let workerFinished = false;
    const shutdown = manager.closeAll("checkpoint").then(() => {
      workerFinished = true;
    });
    await jest.advanceTimersByTimeAsync(10);
    expect(workerFinished).toBe(false);
    receipt.resolve();
    await shutdown;
    expect(workerFinished).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
  });
});
