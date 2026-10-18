jest.mock("../_generated/server", () => ({
  mutation: (c: unknown) => c,
  query: (c: unknown) => c,
}));
jest.mock("../lib/utils", () => ({ validateServiceKey: jest.fn() }));
jest.mock("../lib/suspensionGuards", () => ({
  assertUserCanAccessChatHistory: jest.fn(),
}));
import {
  start,
  update,
  markMessage,
  control,
  claimRun,
  claimDispatch,
  checkpoint,
  finish,
  failDispatch,
  get,
  evidenceForBackend,
} from "../agentGoals";
import { validateServiceKey } from "../lib/utils";

const invoke = (fn: unknown, ctx: unknown, args: unknown): Promise<any> =>
  (fn as { handler: (c: unknown, a: unknown) => Promise<any> }).handler(
    ctx,
    args,
  );
const owner = { serviceKey: "synthetic", chatId: "chat", userId: "owner" };
const startArgs = {
  ...owner,
  objective: "Create marker",
  criteria: ["Marker exists"],
  maxRuns: 3,
  sandboxPreference: "e2b",
  permissionMode: "ask_approval",
  selectedModel: "auto",
};
function database() {
  const rows = new Map<string, any>([
    ["chat-doc", { _id: "chat-doc", id: "chat", user_id: "owner" }],
  ]);
  const tables = new Map<string, string[]>([
    ["chats", ["chat-doc"]],
    ["agent_goals", []],
    ["messages", []],
  ]);
  const ctx = {
    auth: { getUserIdentity: async () => ({ subject: "owner" }) },
    db: {
      query: (table: string) => ({
        withIndex: (_name: string, callback: (q: any) => unknown) => {
          let field = "",
            value: unknown;
          callback({
            eq: (f: string, v: unknown) => {
              field = f;
              value = v;
            },
          });
          return {
            unique: async () =>
              tables
                .get(table)
                ?.map((id) => rows.get(id))
                .find((r) => r[field] === value) ?? null,
          };
        },
      }),
      get: async (id: string) => rows.get(id) ?? null,
      insert: async (table: string, fields: unknown) => {
        const id = `${table}:${tables.get(table)?.length ?? 0}`;
        rows.set(id, { _id: id, _creationTime: 1, ...(fields as object) });
        tables.set(table, [...(tables.get(table) ?? []), id]);
        return id;
      },
      patch: async (id: string, fields: unknown) => {
        rows.set(id, { ...rows.get(id), ...(fields as object) });
      },
      replace: async (id: string, fields: unknown) => {
        rows.set(id, { _id: id, _creationTime: 1, ...(fields as object) });
      },
    },
  };
  return {
    ctx,
    chat: () => rows.get("chat-doc"),
    goal: () => rows.get("agent_goals:0"),
    message: (id: string, parts: unknown[], chat_id = "chat") =>
      ctx.db.insert("messages", { id, chat_id, parts, role: "assistant" }),
  };
}
const proof = {
  criterion: 0,
  runId: "r1",
  toolCallId: "cmd",
  explanation: "Observed marker",
};
const result = {
  type: "tool-run_terminal_cmd",
  toolCallId: "cmd",
  state: "output-available",
  output: { result: { exitCode: 0, output: "marker" } },
};
const terminal = {
  ...owner,
  runId: "r1",
  canceled: false,
  failed: false,
  usageExhausted: false,
  finishReason: "stop",
};

describe("persistent goal lifecycle", () => {
  beforeEach(() => jest.clearAllMocks());
  it("requires authenticated ownership and the service key", async () => {
    const db = database();
    db.chat().user_id = "other";
    await expect(invoke(start, db.ctx, startArgs)).rejects.toThrow(
      "Goal chat unavailable",
    );
    expect(validateServiceKey).toHaveBeenCalledWith("synthetic");
    await expect(invoke(get, db.ctx, { chatId: "chat" })).rejects.toThrow();
    db.chat().user_id = "owner";
    db.chat().deletion_started_at = 1;
    await expect(invoke(start, db.ctx, startArgs)).rejects.toThrow();
  });
  it("claims one worker per generation and rejects duplicate and stale dispatches", async () => {
    const db = database();
    await invoke(start, db.ctx, startArgs);
    expect(
      await invoke(claimDispatch, db.ctx, {
        ...owner,
        generation: 1,
        dispatchId: "d1",
      }),
    ).toBe(true);
    expect(
      await invoke(claimDispatch, db.ctx, {
        ...owner,
        generation: 1,
        dispatchId: "d2",
      }),
    ).toBe(false);
    expect(
      await invoke(claimRun, db.ctx, {
        ...owner,
        generation: 1,
        runId: "r1",
        approvalSessionId: "approval1",
      }),
    ).not.toBeNull();
    expect(db.chat().active_agent_approval_session_id).toBe("approval1");
    expect(
      await invoke(claimRun, db.ctx, { ...owner, generation: 1, runId: "r2" }),
    ).toBeNull();
    expect(db.goal().runs).toBe(1);
  });
  it("keeps pause authoritative against late checkpoints, completion, and dispatch", async () => {
    const db = database();
    await invoke(start, db.ctx, startArgs);
    await invoke(claimRun, db.ctx, { ...owner, generation: 1, runId: "r1" });
    await invoke(control, db.ctx, { ...owner, action: "pause" });
    expect(
      await invoke(checkpoint, db.ctx, {
        ...owner,
        runId: "r1",
        checkpoint: {
          outcome: "achieved",
          progress: "Late result",
          evidence: [proof],
        },
      }),
    ).toBe(false);
    await invoke(finish, db.ctx, {
      ...terminal,
      judgment: { verdict: "done", reason: "Late judge" },
    });
    expect(db.goal().state).toBe("paused");
    expect(db.goal().activeRunId).toBeUndefined();
    db.chat().active_trigger_run_id = undefined;
    await invoke(control, db.ctx, { ...owner, action: "resume" });
    expect(db.goal().runs).toBe(1);
    expect(db.goal().generation).toBe(2);
    expect(
      await invoke(claimRun, db.ctx, {
        ...owner,
        generation: 1,
        runId: "stale",
      }),
    ).toBeNull();
  });
  it("verifies saved evidence, including fallback message IDs, before completion", async () => {
    const db = database();
    await invoke(start, db.ctx, startArgs);
    await invoke(claimRun, db.ctx, { ...owner, generation: 1, runId: "r1" });
    await invoke(checkpoint, db.ctx, {
      ...owner,
      runId: "r1",
      checkpoint: {
        outcome: "achieved",
        progress: "Observed marker",
        evidence: [proof],
      },
    });
    const messageDocId = await db.message("retry-message", [result]);
    await invoke(finish, db.ctx, {
      ...terminal,
      messageId: "retry-message",
      judgment: { verdict: "done", reason: "Marker observed" },
    });
    expect(db.goal().state).toBe("achieved");
    expect(
      (await db.ctx.db.get(messageDocId)).goal.achievedElapsedMs,
    ).toBeGreaterThanOrEqual(0);
    expect(db.goal().achievedAt).toBeGreaterThanOrEqual(db.goal().startedAt);
    expect(db.goal().evidence[0].messageId).toBe("retry-message");
    expect(
      (await invoke(evidenceForBackend, db.ctx, owner))[0].result,
    ).toContain("marker");
  });
  it("rejects a completion claim backed by another chat's message", async () => {
    const db = database();
    await invoke(start, db.ctx, startArgs);
    await invoke(claimRun, db.ctx, { ...owner, generation: 1, runId: "r1" });
    await invoke(checkpoint, db.ctx, {
      ...owner,
      runId: "r1",
      checkpoint: { outcome: "achieved", progress: "Claim", evidence: [proof] },
    });
    await db.message("r1", [result], "other-chat");
    await invoke(finish, db.ctx, {
      ...terminal,
      judgment: { verdict: "done", reason: "Claim" },
    });
    expect(db.goal().state).toBe("queued");
    expect(db.goal().evidence).toEqual([]);
  });
  it("waits until the wake time and can recover a failed delayed dispatch", async () => {
    const db = database();
    await invoke(start, db.ctx, startArgs);
    await invoke(claimRun, db.ctx, { ...owner, generation: 1, runId: "r1" });
    await invoke(checkpoint, db.ctx, {
      ...owner,
      runId: "r1",
      checkpoint: {
        outcome: "wait",
        progress: "Authorized job pending",
        evidence: [],
        waitSeconds: 30,
      },
    });
    await invoke(finish, db.ctx, terminal);
    db.chat().active_trigger_run_id = undefined;
    expect(db.goal().state).toBe("waiting");
    expect(
      await invoke(claimRun, db.ctx, { ...owner, generation: 2, runId: "r2" }),
    ).toBeNull();
    db.goal().waitUntil = Date.now() - 1;
    expect(
      await invoke(claimRun, db.ctx, { ...owner, generation: 2, runId: "r2" }),
    ).not.toBeNull();
    await db.message("r2", [result]);
    await invoke(finish, db.ctx, { ...terminal, runId: "r2" });
    db.chat().active_trigger_run_id = undefined;
    await invoke(failDispatch, db.ctx, {
      ...owner,
      generation: db.goal().generation,
    });
    expect(db.goal().state).toBe("failed");
  });
  it("retains cumulative budget and requires an explicit extension", async () => {
    const db = database();
    await invoke(start, db.ctx, { ...startArgs, maxRuns: 1 });
    await invoke(claimRun, db.ctx, { ...owner, generation: 1, runId: "r1" });
    await invoke(finish, db.ctx, terminal);
    db.chat().active_trigger_run_id = undefined;
    expect(db.goal().state).toBe("budget_exhausted");
    await expect(
      invoke(control, db.ctx, { ...owner, action: "resume" }),
    ).rejects.toThrow("Run budget exhausted");
    await invoke(control, db.ctx, {
      ...owner,
      action: "resume",
      additionalRuns: 2,
    });
    expect(db.goal().runs).toBe(1);
    expect(db.goal().maxRuns).toBe(3);
    await invoke(control, db.ctx, { ...owner, action: "pause" });
    await expect(
      invoke(control, db.ctx, {
        ...owner,
        action: "resume",
        additionalRuns: 6,
      }),
    ).rejects.toThrow("8 runs");
  });
});

describe("editing and deleting an active goal", () => {
  it("pauses editing, preserves spent budget, and rejects old completion evidence", async () => {
    const db = database();
    await invoke(start, db.ctx, startArgs);
    await invoke(claimRun, db.ctx, { ...owner, generation: 1, runId: "r1" });
    const edited = await invoke(update, db.ctx, {
      ...owner,
      generation: 1,
      objective: "New marker",
      criteria: ["New marker exists"],
    });
    expect(edited).toMatchObject({
      state: "paused",
      runs: 1,
      maxRuns: 3,
      evidence: [],
      generation: 2,
    });
    expect(db.chat().canceled_at).toEqual(expect.any(Number));
    await invoke(finish, db.ctx, {
      ...terminal,
      judgment: { verdict: "done", reason: "Old objective completed" },
    });
    expect(db.goal()).toMatchObject({
      state: "paused",
      objective: "New marker",
      evidence: [],
    });
    expect(db.goal().judgment).toBeUndefined();
    expect(db.goal().activeRunId).toBeUndefined();
    await expect(
      invoke(update, db.ctx, {
        ...owner,
        generation: 1,
        objective: "Stale",
        criteria: ["Stale"],
      }),
    ).rejects.toThrow("Goal changed");
  });
  it("hides a deleted goal and fences stale dispatches without resetting its generation", async () => {
    const db = database();
    await invoke(start, db.ctx, startArgs);
    await invoke(claimRun, db.ctx, { ...owner, generation: 1, runId: "r1" });
    await invoke(control, db.ctx, { ...owner, action: "clear" });
    expect(await invoke(get, db.ctx, { chatId: "chat" })).toBeNull();
    await invoke(finish, db.ctx, terminal);
    await expect(
      invoke(control, db.ctx, { ...owner, action: "resume" }),
    ).rejects.toThrow();
    db.chat().active_trigger_run_id = undefined;
    const next = await invoke(start, db.ctx, startArgs);
    expect(next.generation).toBe(3);
    expect(
      await invoke(claimDispatch, db.ctx, {
        ...owner,
        generation: 1,
        dispatchId: "old",
      }),
    ).toBe(false);
  });
  it("saves goal labels only on the owner's user message", async () => {
    const db = database();
    await invoke(start, db.ctx, startArgs);
    const id = await db.ctx.db.insert("messages", {
      id: "user-message",
      chat_id: "chat",
      role: "user",
      parts: [],
    });
    await invoke(markMessage, db.ctx, {
      ...owner,
      messageId: "user-message",
      generation: 1,
    });
    expect((await db.ctx.db.get(id)).goal).toEqual({ sent: true });
    await expect(
      invoke(markMessage, db.ctx, {
        ...owner,
        userId: "other",
        messageId: "user-message",
        generation: 1,
      }),
    ).rejects.toThrow();
  });
});
