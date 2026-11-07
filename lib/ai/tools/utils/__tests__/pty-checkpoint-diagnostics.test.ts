import { phLogger } from "@/lib/posthog/server";
import { createCommandSessionHandle } from "../command-session-handle";
import { PtySessionManager, type PtySession } from "../pty-session-manager";
import {
  createTerminalRecordStore,
  type TerminalExecutionRecord,
} from "../terminal-execution-record";
import type { AnySandbox } from "@/types";
import {
  checkpointCommandContext,
  PersistenceError,
  persistenceCommandError,
} from "../persistence-failure";
import { LocalFileRequestError } from "../local-sandbox-errors";

jest.mock("@/lib/posthog/server", () => ({
  phLogger: { info: jest.fn() },
}));

describe("unconfirmed terminal checkpoint diagnostics", () => {
  const sessions: { manager: PtySessionManager; session: PtySession }[] = [];
  const info = jest.mocked(phLogger.info);

  beforeEach(() => {
    jest.useFakeTimers();
    info.mockReset();
  });
  afterEach(async () => {
    for (const { manager, session } of sessions.splice(0))
      await manager.close(session.chatId, session.sessionId);
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  async function fixture(
    save: (record: TerminalExecutionRecord) => Promise<string | null>,
    manager = new PtySessionManager(),
    suppliedStore?: ReturnType<typeof createTerminalRecordStore>,
  ) {
    const kill = jest.fn(async () => true);
    const handle = createCommandSessionHandle({ kill });
    const store =
      suppliedStore ??
      createTerminalRecordStore(
        { sandboxId: "PRIVATE_SANDBOX" } as unknown as AnySandbox,
        "PRIVATE_USER",
        "PRIVATE_SCOPE",
      );
    const session = await manager.create("PRIVATE_SCOPE", {
      createHandle: async () => handle,
      cols: 120,
      rows: 30,
      kind: "command",
      sandboxIdentity: "e2b",
      originalCommand: "PRIVATE_COMMAND",
      workingDirectory: "/PRIVATE_DIRECTORY",
      executionRecord: {
        sandboxInstance: "PRIVATE_SANDBOX",
        artifactPaths: ["/PRIVATE_ARTIFACT"],
        checkpointOnStart: false,
        checkpointOnOutput: false,
        pruneOnStart: false,
        save,
        prune: async () => {},
        reportCheckpointIssue: store.reportCheckpointIssue,
      },
    });
    sessions.push({ manager, session });
    handle.emitText("PRIVATE_OUTPUT");
    return { manager, session, handle, kill };
  }

  function failingStore(error: unknown) {
    const write = jest
      .fn<Promise<void>, [string, string]>()
      .mockRejectedValue(error);
    const store = createTerminalRecordStore(
      {
        sandboxId: "PRIVATE_SANDBOX",
        files: { write },
      } as unknown as AnySandbox,
      "PRIVATE_USER",
      "PRIVATE_SCOPE",
    );
    return { store, write };
  }

  it.each([
    [
      persistenceCommandError("Failed to write file", {
        exitCode: 17,
        stderr: "PRIVATE_STDERR",
      }),
      {
        failure_category: "unknown",
        checkpoint_failure_origin: "other_error",
        command_stage: "write_file",
        command_exit_code: 17,
      },
    ],
    [
      persistenceCommandError("Failed to decode file", { exitCode: 1 }),
      {
        failure_category: "unknown",
        checkpoint_failure_origin: "other_error",
        command_stage: "decode_file",
        command_exit_code: 1,
      },
    ],
    [
      new LocalFileRequestError("timeout", "PRIVATE_TIMEOUT"),
      {
        failure_category: "timeout",
        checkpoint_failure_origin: "local_file_request",
        command_stage: "none",
        command_exit_code: "none",
      },
    ],
  ])(
    "retains finite failed-write context on the existing session diagnostic",
    async (error, expected) => {
      const { store } = failingStore(error);
      const { manager, session } = await fixture(store.save, undefined, store);
      for (let i = 0; i < 3; i++) await manager.checkpoint(session);
      expect(session.recordPersistenceFailed).toBe(true);
      expect(info).toHaveBeenCalledTimes(1);
      expect(info).toHaveBeenCalledWith(
        "terminal_record_checkpoint_unconfirmed",
        expect.objectContaining({
          reason: "save_unacknowledged",
          terminal_session_id: session.sessionId,
          checkpoint_backend: "cloud",
          checkpoint_transport: "native_file",
          file_failure: "none",
          ...expected,
        }),
      );
      expect(JSON.stringify(info.mock.calls)).not.toContain("PRIVATE_");
    },
  );

  it("does not attribute another session's failure or retain it after successful recovery", async () => {
    const { store, write } = failingStore(
      persistenceCommandError("Failed to write file", { exitCode: 4 }),
    );
    const { manager, session } = await fixture(store.save, undefined, store);
    await manager.checkpoint(session);
    const report = (
      id: string,
      reason: "save_unacknowledged" | "wait_deadline" = "save_unacknowledged",
    ) =>
      store.reportCheckpointIssue({
        terminalSessionId: id,
        sessionKind: "command",
        reason,
      });
    info.mockClear();
    report("abcdef12");
    report(session.sessionId, "wait_deadline");
    for (const [, fields] of info.mock.calls)
      expect(fields).not.toHaveProperty("failure_category");
    write.mockResolvedValue(undefined);
    await manager.checkpoint(session);
    expect(session.recordPersistenceFailed).toBe(false);
    info.mockClear();
    report(session.sessionId);
    expect(info.mock.calls[0][1]).not.toHaveProperty("failure_category");
  });

  it("rejects private or malformed command details and never invokes optional error accessors", () => {
    const error = new PersistenceError("PRIVATE_MESSAGE", "unknown", 1000000);
    expect(checkpointCommandContext(error)).toEqual({
      command_stage: "other",
      command_exit_code: "other",
    });
    const getter = jest.fn(() => {
      throw new Error("PRIVATE_GETTER");
    });
    Object.defineProperty(error, "message", { get: getter });
    Object.defineProperty(error, "exitCode", { get: getter });
    expect(checkpointCommandContext(error)).toEqual({
      command_stage: "other",
      command_exit_code: "none",
    });
    expect(getter).not.toHaveBeenCalled();
  });

  it("keeps malformed record rejection best effort without retaining unrelated context", async () => {
    const { store } = failingStore(new Error("PRIVATE_FAILURE"));
    await expect(
      store.save(null as unknown as TerminalExecutionRecord),
    ).resolves.toBeNull();
    store.reportCheckpointIssue({
      terminalSessionId: "abcdef12",
      sessionKind: "command",
      reason: "save_unacknowledged",
    });
    expect(info.mock.calls[0][1]).not.toHaveProperty("failure_category");
    expect(JSON.stringify(info.mock.calls)).not.toContain("PRIVATE_");
  });

  it("distinguishes unacknowledged saves from thrown writes without leaking record content", async () => {
    const save = jest
      .fn<Promise<string | null>, [TerminalExecutionRecord]>()
      .mockResolvedValue(null);
    const { manager, session } = await fixture(save);
    await manager.checkpoint(session);
    expect(session.recordPersistenceFailed).toBe(true);
    save.mockRejectedValueOnce(new Error("PRIVATE_PROVIDER_ERROR"));
    await manager.checkpoint(session);
    expect(session.recordPersistenceFailed).toBe(true);
    expect(info.mock.calls).toEqual([
      [
        "terminal_record_checkpoint_unconfirmed",
        {
          terminal_scope_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          terminal_session_id: session.sessionId,
          session_kind: "command",
          reason: "save_unacknowledged",
          diagnostic_version: 1,
          diagnostic_scope: "first_reason_per_terminal_session",
        },
      ],
      [
        "terminal_record_checkpoint_unconfirmed",
        {
          terminal_scope_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          terminal_session_id: session.sessionId,
          session_kind: "command",
          reason: "checkpoint_threw",
          diagnostic_version: 1,
          diagnostic_scope: "first_reason_per_terminal_session",
        },
      ],
    ]);
    expect(JSON.stringify(info.mock.calls)).not.toContain("PRIVATE_");
  });

  it("bounds diagnostics by distinct reason across repeated polling and retries", async () => {
    const save = jest
      .fn<Promise<string | null>, [TerminalExecutionRecord]>()
      .mockResolvedValue(null);
    const { manager, session } = await fixture(save);
    for (let i = 0; i < 4; i++) await manager.checkpoint(session);
    for (let i = 0; i < 4; i++) {
      save.mockRejectedValueOnce(new Error("PRIVATE_PROVIDER_ERROR"));
      await manager.checkpoint(session);
    }
    let release!: (path: string | null) => void;
    save.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)),
    );
    const writing = manager.checkpoint(session);
    await jest.advanceTimersByTimeAsync(2_100);
    await writing;
    for (let i = 0; i < 4; i++) {
      const polling = manager.checkpoint(session);
      await jest.advanceTimersByTimeAsync(2_100);
      await polling;
    }
    release(null);
    await jest.advanceTimersByTimeAsync(0);
    expect(info.mock.calls.map(([, fields]) => fields?.reason)).toEqual([
      "save_unacknowledged",
      "checkpoint_threw",
      "wait_deadline",
    ]);
  });

  it("reports a wait deadline while the original write continues and a stopped snapshot is coalesced", async () => {
    let release!: () => void;
    const firstWrite = new Promise<void>((resolve) => (release = resolve));
    const records: TerminalExecutionRecord[] = [];
    const save = jest.fn(async (record: TerminalExecutionRecord) => {
      records.push(record);
      if (records.length === 1) await firstWrite;
      return "/PRIVATE_RECEIPT";
    });
    const { manager, session, kill } = await fixture(save);
    const checkpoint = manager.checkpoint(session);
    const stopping = manager.close(session.chatId, session.sessionId);
    await jest.advanceTimersByTimeAsync(2_100);
    await Promise.all([checkpoint, stopping]);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(session.recordPersistenceFailed).toBe(true);
    expect(info).toHaveBeenCalledWith(
      "terminal_record_checkpoint_unconfirmed",
      expect.objectContaining({ reason: "wait_deadline" }),
    );
    expect(info).toHaveBeenCalledTimes(1);
    release();
    await jest.advanceTimersByTimeAsync(0);
    expect(session.recordPersistenceFailed).toBe(false);
    expect(records.map((record) => record.status)).toEqual([
      "running",
      "stopped",
    ]);
    expect(save).toHaveBeenCalledTimes(2);
    expect(info).toHaveBeenCalledTimes(1);
  });

  it("reports an unacknowledged save that arrives after its first wait deadline", async () => {
    let release!: (path: string | null) => void;
    const save = jest.fn(
      () => new Promise<string | null>((resolve) => (release = resolve)),
    );
    const { manager, session } = await fixture(save);
    const writing = manager.checkpoint(session);
    try {
      await jest.advanceTimersByTimeAsync(2_100);
      await writing;
      expect(info.mock.calls.map(([, fields]) => fields?.reason)).toEqual([
        "wait_deadline",
      ]);
      release(null);
      await jest.advanceTimersByTimeAsync(0);
      expect(info.mock.calls.map(([, fields]) => fields?.reason)).toEqual([
        "wait_deadline",
        "save_unacknowledged",
      ]);
    } finally {
      release(null);
      await jest.advanceTimersByTimeAsync(0);
      save.mockResolvedValue(null);
    }
  });

  it("preserves persistence results when the diagnostic sink throws", async () => {
    info.mockImplementation(() => {
      throw new Error("PRIVATE_SINK_ERROR");
    });
    const save = jest
      .fn<Promise<string | null>, [TerminalExecutionRecord]>()
      .mockResolvedValue(null);
    const { manager, session } = await fixture(save);
    await expect(manager.checkpoint(session)).resolves.toBeUndefined();
    expect(session.recordPersistenceFailed).toBe(true);
    expect(info).toHaveBeenCalledTimes(1);
    save.mockResolvedValue("/PRIVATE_RECEIPT");
    await expect(manager.checkpoint(session)).resolves.toBeUndefined();
    expect(session.recordPersistenceFailed).toBe(false);
    expect(info).toHaveBeenCalledTimes(1);
  });

  it("keeps successful and unchanged checkpoints quiet", async () => {
    const save = jest.fn(async () => "/PRIVATE_RECEIPT");
    const { manager, session } = await fixture(save);
    for (let i = 0; i < 4; i++) await manager.checkpoint(session);
    expect(session.recordPersistenceFailed).toBe(false);
    expect(save).toHaveBeenCalledTimes(1);
    expect(info).not.toHaveBeenCalled();
  });

  it("keeps the diagnostic budget separate for sessions in the same terminal scope", async () => {
    const manager = new PtySessionManager();
    const save = jest.fn(async () => null);
    const first = await fixture(save, manager);
    const second = await fixture(save, manager);
    await manager.checkpoint(first.session);
    await manager.checkpoint(second.session);
    expect(
      info.mock.calls.map(([, fields]) => fields?.terminal_session_id),
    ).toEqual([first.session.sessionId, second.session.sessionId]);
    expect(first.session.sessionId).not.toBe(second.session.sessionId);
    expect(
      new Set(
        info.mock.calls.map(([, fields]) => fields?.terminal_scope_fingerprint),
      ).size,
    ).toBe(1);
  });
});
