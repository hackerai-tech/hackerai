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
  checkpointCloudErrorContext,
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

  /** Create an owned command session, optionally backed by the real record store. */
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

  /** Model a failed cloud or native write without executing customer commands. */
  function failingStore(error: unknown, local = false) {
    const write = jest
      .fn<Promise<void>, [string, string]>()
      .mockRejectedValue(error);
    const store = createTerminalRecordStore(
      {
        sandboxId: "PRIVATE_SANDBOX",
        files: { write },
        ...(local
          ? {
              sandboxKind: "centrifugo",
              getConnectionId: () => "PRIVATE_CONNECTION",
              getWorkingDirectory: () => "C:/PRIVATE_FOLDER",
              isWindows: () => true,
              supportsNativeFileRelay: () => true,
            }
          : {}),
      } as unknown as AnySandbox,
      "PRIVATE_USER",
      "PRIVATE_SCOPE",
    );
    return { store, write };
  }

  it.each([
    ...[
      [-1, "sentinel_minus_one"],
      [-9, "negative_integer"],
      [1_000_000, "out_of_range"],
      [NaN, "non_integer"],
      ["PRIVATE_EXIT_CODE", "non_numeric"],
    ].map(([exitCode, shape]) => [
      Object.defineProperty(
        new PersistenceError(
          "Private terminal artifact operation failed",
          "unknown",
        ),
        "exitCode",
        { value: exitCode },
      ),
      {
        failure_category: "unknown",
        checkpoint_failure_origin: "other_error",
        command_stage: "private_artifact",
        command_exit_code: "other",
        command_exit_code_shape: shape,
      },
    ]),
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
      command_exit_code_shape: "out_of_range",
    });
    const getter = jest.fn(() => {
      throw new Error("PRIVATE_GETTER");
    });
    Object.defineProperty(error, "message", { get: getter });
    Object.defineProperty(error, "exitCode", { get: getter });
    expect(checkpointCommandContext(error)).toEqual({
      command_stage: "other",
      command_exit_code: "none",
      command_exit_code_shape: "none",
    });
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    [
      Object.assign(new Error("PRIVATE_PATH"), {
        name: "FileNotFoundError",
        statusCode: 404,
      }),
      "file_not_found",
      404,
    ],
    [
      Object.assign(new Error("PRIVATE_SANDBOX"), {
        name: "SandboxNotFoundError",
        statusCode: 404,
      }),
      "sandbox_not_found",
      404,
    ],
    [
      new Error("Expected to receive information about written file"),
      "empty_write_response",
      "none",
    ],
  ])(
    "retains the closed cloud SDK failure kind and HTTP status without private text",
    async (error, kind, status) => {
      const { store } = failingStore(error);
      const { manager, session } = await fixture(store.save, undefined, store);
      await manager.checkpoint(session);
      expect(session.recordPersistenceFailed).toBe(true);
      expect(info).toHaveBeenCalledTimes(1);
      expect(info).toHaveBeenCalledWith(
        "terminal_record_checkpoint_unconfirmed",
        expect.objectContaining({
          cloud_error_kind: kind,
          cloud_http_status: status,
        }),
      );
      expect(JSON.stringify(info.mock.calls)).not.toContain("PRIVATE_");
    },
  );

  it("keeps malformed cloud metadata finite without evaluating error accessors", () => {
    const error = Object.assign(new Error("PRIVATE_MESSAGE"), {
      name: "PRIVATE_ERROR_KIND",
      statusCode: "PRIVATE_STATUS",
    });
    expect(checkpointCloudErrorContext(error)).toEqual({
      cloud_error_kind: "other_error",
      cloud_http_status: "other",
    });
    const getter = jest.fn(() => {
      throw new Error("PRIVATE_GETTER");
    });
    for (const key of ["name", "message", "statusCode"])
      Object.defineProperty(error, key, { get: getter });
    expect(checkpointCloudErrorContext(error)).toEqual({
      cloud_error_kind: "other_error",
      cloud_http_status: "none",
    });
    expect(getter).not.toHaveBeenCalled();
    expect(
      checkpointCloudErrorContext({ name: "SandboxError", statusCode: 600 }),
    ).toEqual({
      cloud_error_kind: "sandbox_error",
      cloud_http_status: "other",
    });
  });

  it.each([
    [
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("PRIVATE_HOST"), { code: "ECONNRESET" }),
      }),
      "fetch_failed",
      "ECONNRESET",
    ],
    [new TypeError("PRIVATE_SDK_DETAIL"), "other_type_error", "none"],
    [
      Object.assign(new TypeError("PRIVATE_SDK_DETAIL"), {
        code: "PRIVATE_CODE",
      }),
      "other_type_error",
      "other",
    ],
  ])(
    "distinguishes cloud fetch failures on the existing capped diagnostic without exposing their causes",
    async (error, signal, code) => {
      const { store, write } = failingStore(error);
      const { manager, session } = await fixture(store.save, undefined, store);
      for (let i = 0; i < 3; i++) await manager.checkpoint(session);
      expect(session.recordPersistenceFailed).toBe(true);
      expect(write).toHaveBeenCalledTimes(3);
      expect(info).toHaveBeenCalledTimes(1);
      expect(info).toHaveBeenCalledWith(
        "terminal_record_checkpoint_unconfirmed",
        expect.objectContaining({
          checkpoint_backend: "cloud",
          checkpoint_failure_origin: "type_error",
          cloud_type_error_signal: signal,
          cloud_transport_code: code,
        }),
      );
      expect(JSON.stringify(info.mock.calls)).not.toContain("PRIVATE_");
    },
  );

  it("reads only a direct transport code or the first cause, with root precedence", () => {
    const nested = new TypeError("fetch failed", {
      cause: new Error("PRIVATE_CAUSE", {
        cause: { code: "ECONNRESET" },
      }),
    });
    expect(checkpointCloudErrorContext(nested)).toMatchObject({
      cloud_type_error_signal: "fetch_failed",
      cloud_transport_code: "none",
    });
    Object.assign(nested, { code: "ETIMEDOUT" });
    expect(checkpointCloudErrorContext(nested)).toMatchObject({
      cloud_transport_code: "ETIMEDOUT",
    });
    // SDK HTTP errors retain their existing vocabulary; TypeError-only fields
    // must not imply network attribution for every cloud failure.
    expect(
      checkpointCloudErrorContext({ name: "TimeoutError", statusCode: 504 }),
    ).toEqual({ cloud_error_kind: "timeout", cloud_http_status: 504 });
  });

  it("does not invoke TypeError message/code/cause getters or expose proxy failures", () => {
    const getter = jest.fn(() => {
      throw new Error("PRIVATE_GETTER");
    });
    const error = new TypeError("PRIVATE_MESSAGE");
    Object.defineProperty(error, "message", { get: getter });
    Object.defineProperty(error, "code", { get: getter, configurable: true });
    expect(checkpointCloudErrorContext(error)).toMatchObject({
      cloud_type_error_signal: "unreadable",
      cloud_transport_code: "unreadable",
    });
    delete (error as unknown as { code?: unknown }).code;
    Object.defineProperty(error, "cause", { get: getter, configurable: true });
    expect(checkpointCloudErrorContext(error)).toMatchObject({
      cloud_transport_code: "unreadable",
    });
    expect(getter).not.toHaveBeenCalled();
    const reflect = jest.fn(() => {
      throw new Error("PRIVATE_PROXY");
    });
    Object.defineProperty(error, "cause", {
      value: new Proxy({}, { getOwnPropertyDescriptor: reflect }),
    });
    expect(checkpointCloudErrorContext(error)).toMatchObject({
      cloud_transport_code: "unreadable",
    });
    expect(reflect).toHaveBeenCalledTimes(1);
    expect(getter).not.toHaveBeenCalled();
    expect(JSON.stringify(checkpointCloudErrorContext(error))).not.toContain(
      "PRIVATE_",
    );
  });

  it("ignores inherited TypeError metadata without invoking it", () => {
    const getter = jest.fn(() => "ECONNRESET");
    const error = new TypeError("fetch failed");
    Object.setPrototypeOf(
      error,
      Object.create(TypeError.prototype, {
        code: { get: getter },
        cause: { get: getter },
      }),
    );
    expect(checkpointCloudErrorContext(error)).toMatchObject({
      cloud_type_error_signal: "fetch_failed",
      cloud_transport_code: "none",
    });
    expect(getter).not.toHaveBeenCalled();
  });

  it("does not attribute cloud SDK fields to a local transport failure", async () => {
    const { store } = failingStore(
      Object.assign(new Error("PRIVATE_MESSAGE"), {
        name: "FileNotFoundError",
        statusCode: 404,
      }),
      true,
    );
    const { manager, session } = await fixture(store.save, undefined, store);
    await manager.checkpoint(session);
    expect(session.recordPersistenceFailed).toBe(true);
    expect(info).toHaveBeenCalledTimes(1);
    const fields = info.mock.calls[0][1];
    expect(fields).toMatchObject({
      checkpoint_backend: "local",
      reason: "save_unacknowledged",
    });
    expect(fields).not.toHaveProperty("cloud_error_kind");
    expect(fields).not.toHaveProperty("cloud_http_status");
    expect(fields).not.toHaveProperty("cloud_type_error_signal");
    expect(fields).not.toHaveProperty("cloud_transport_code");
    expect(JSON.stringify(info.mock.calls)).not.toContain("PRIVATE_");
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
