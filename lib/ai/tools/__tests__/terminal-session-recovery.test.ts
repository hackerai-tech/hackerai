jest.mock("@e2b/code-interpreter", () => ({
  CommandExitError: class extends Error {},
  Sandbox: class {},
}));
jest.mock("@/lib/posthog/server", () => ({
  phLogger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

import { createInteractTerminalSession } from "../interact-terminal-session";
import { createCommandSessionHandle } from "../utils/command-session-handle";
import { PtySessionManager } from "../utils/pty-session-manager";
import { createTerminalRecordStore } from "../utils/terminal-execution-record";

/** Hold record writes independently so recovery cannot mistake a running snapshot for the final record. */
async function fixture(coalesced = false) {
  let failSave = false;
  let releaseFirst!: () => void;
  const receipt = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let releaseFinal = releaseFirst;
  const finalReceipt = coalesced
    ? new Promise<void>((resolve) => {
        releaseFinal = resolve;
      })
    : receipt;
  const release = () => {
    releaseFirst();
    releaseFinal();
  };
  let writes = 0;
  const files = new Map<string, string>();
  const sandbox: any = {
    sandboxId: "recovery-fixture",
    jupyterUrl: "http://fixture.invalid",
    files: {
      write: async (path: string, value: string) => {
        await (writes++ === 0 ? receipt : finalReceipt);
        if (failSave) throw new Error("synthetic write failure");
        files.set(path, value);
      },
      read: async (path: string) => {
        if (!files.has(path)) throw new Error("missing");
        return files.get(path)!;
      },
      list: async () => [],
      remove: async (path: string) => {
        files.delete(path);
      },
    },
  };
  const manager = new PtySessionManager();
  const kill = jest.fn(async () => true);
  const handle = createCommandSessionHandle({ kill });
  const createHandle = jest.fn(async () => handle);
  const store = createTerminalRecordStore(
    sandbox,
    "fixture-user",
    "fixture-chat",
  );
  const session = await manager.create("fixture-chat", {
    createHandle,
    cols: 80,
    rows: 24,
    kind: "command",
    sandboxIdentity: "e2b",
    originalCommand: "synthetic command",
    executionRecord: {
      ...store,
      sandboxInstance: "e2b:recovery-fixture",
      artifactPaths: [],
      checkpointOnStart: false,
      checkpointOnOutput: false,
      pruneOnStart: false,
    },
  });
  if (coalesced) {
    handle.emitText("earlier running output; ");
    const checkpoint = manager.checkpoint(session);
    await jest.advanceTimersByTimeAsync(2001);
    await checkpoint;
  }
  handle.emitText("retained failed-command output");
  handle.resolveExit(7);
  const forgotten = manager.forget("fixture-chat", session.sessionId);
  await jest.advanceTimersByTimeAsync(2001);
  await forgotten;
  const context: any = {
    chatId: "fixture-chat",
    userID: "fixture-user",
    ptySessionManager: manager,
    writer: { write() {} },
    sandboxManager: {
      getSandbox: async () => ({ sandbox }),
      consumeFallbackInfo: () => null,
    },
  };
  const interact = async (
    action: string,
    scope = "fixture-chat",
    id = session.sessionId,
  ) => {
    const tool = createInteractTerminalSession({ ...context, chatId: scope });
    return (tool.execute as any)(
      { session: id, action, brief: "Inspect synthetic record" },
      { toolCallId: "fixture-view", messages: [] },
    );
  };
  return {
    manager,
    session,
    release,
    releaseFirst,
    releaseFinal,
    interact,
    createHandle,
    kill,
    failSave: () => {
      failSave = true;
      release();
    },
  };
}

describe("completed terminal record recovery during a pending save", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test("reports pending, then recovers the same failed command without restarting it", async () => {
    const f = await fixture();
    try {
      expect(
        f.manager.get("fixture-chat", f.session.sessionId),
      ).toBeUndefined();
      const view = f.interact("view");
      await jest.advanceTimersByTimeAsync(2001);
      expect(await view).toMatchObject({
        result: {
          session: f.session.sessionId,
          recordPersistencePending: true,
          resumable: false,
        },
      });
      f.release();
      await f.manager.closeAll("fixture-chat");
      expect(await f.interact("view")).toMatchObject({
        result: {
          session: f.session.sessionId,
          recovered: true,
          resumable: false,
          status: "failed",
          exitCode: 7,
          output: "retained failed-command output",
        },
      });
      expect(f.createHandle).toHaveBeenCalledTimes(1);
      expect(f.kill).not.toHaveBeenCalled();
    } finally {
      f.release();
      await f.manager.closeAll("fixture-chat");
    }
  });

  test("recovers immediately when that session's pending save settles inside the wait", async () => {
    const f = await fixture();
    try {
      const view = f.interact("wait");
      await jest.advanceTimersByTimeAsync(1);
      f.release();
      expect(await view).toMatchObject({
        result: { recovered: true, exitCode: 7 },
      });
    } finally {
      f.release();
      await f.manager.closeAll("fixture-chat");
    }
  });

  test("waits for the final coalesced record instead of recovering an earlier running snapshot", async () => {
    const f = await fixture(true);
    try {
      const view = f.interact("view");
      await jest.advanceTimersByTimeAsync(1);
      f.releaseFirst();
      await jest.advanceTimersByTimeAsync(2001);
      expect(await view).toMatchObject({
        result: { recordPersistencePending: true },
      });
      f.releaseFinal();
      await f.manager.closeAll("fixture-chat");
      expect(await f.interact("view")).toMatchObject({
        result: {
          recovered: true,
          status: "failed",
          exitCode: 7,
          output: "earlier running output; retained failed-command output",
        },
      });
      expect(f.createHandle).toHaveBeenCalledTimes(1);
    } finally {
      f.release();
      await f.manager.closeAll("fixture-chat");
    }
  });

  test("settles a failed save without claiming it is still pending or advising a replay", async () => {
    const f = await fixture();
    try {
      const view = f.interact("view");
      await jest.advanceTimersByTimeAsync(1);
      f.failSave();
      const result = await view;
      expect(result.result.recordPersistencePending).not.toBe(true);
      expect(result.result.error).toContain(
        "do not repeat it solely because this lookup failed",
      );
      expect(f.createHandle).toHaveBeenCalledTimes(1);
    } finally {
      f.release();
      await f.manager.closeAll("fixture-chat");
    }
  });

  test.each(["send", "kill"])(
    "never performs %s against a pending historical record",
    async (action) => {
      const f = await fixture();
      try {
        const result = f.interact(action);
        await jest.advanceTimersByTimeAsync(2001);
        expect(await result).toMatchObject({
          result: {
            recordPersistencePending: true,
            resumable: false,
            error: expect.stringContaining("not performed"),
          },
        });
        expect(f.kill).not.toHaveBeenCalled();
        expect(f.createHandle).toHaveBeenCalledTimes(1);
      } finally {
        f.release();
        await f.manager.closeAll("fixture-chat");
      }
    },
  );

  test("does not let another chat or session's pending write delay a missing-session lookup", async () => {
    const f = await fixture();
    try {
      for (const [scope, id] of [
        ["other-chat", f.session.sessionId],
        ["fixture-chat", "00000000"],
      ]) {
        let result: any;
        const lookup = f.interact("view", scope, id).then((value) => {
          result = value;
        });
        await jest.advanceTimersByTimeAsync(1);
        expect(result).toMatchObject({
          result: { error: expect.stringContaining("not found") },
        });
        await lookup;
      }
    } finally {
      f.release();
      await f.manager.closeAll("fixture-chat");
    }
  });
});
