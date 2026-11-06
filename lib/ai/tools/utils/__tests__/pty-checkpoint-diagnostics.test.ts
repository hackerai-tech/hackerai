import { phLogger } from "@/lib/posthog/server";
import { createCommandSessionHandle } from "../command-session-handle";
import { PtySessionManager, type PtySession } from "../pty-session-manager";
import type { TerminalExecutionRecord } from "../terminal-execution-record";

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
  ) {
    const kill = jest.fn(async () => true);
    const handle = createCommandSessionHandle({ kill });
    const session = await manager.create("opaque-chat", {
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
      },
    });
    sessions.push({ manager, session });
    handle.emitText("PRIVATE_OUTPUT");
    return { manager, session, handle, kill };
  }

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
          terminal_scope_id: "opaque-chat",
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
          terminal_scope_id: "opaque-chat",
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
  });
});
