import type { ToolSet } from "ai";
import { StoppedWorkRuntime } from "../stopped-work-runtime";
import { stoppedWorkPrompt } from "../stopped-work";
import {
  serializeChatSDKErrorForStream,
  deserializeChatSDKErrorFromStream,
} from "@/lib/errors";
import { assertStoppedWorkAdmission } from "@/convex/lib/stoppedWork";

jest.mock("@/lib/ai/providers", () => ({
  myProvider: {},
  resolveTierToProviderKey: () => "review-model",
}));
jest.mock("../agent-auto-review", () => ({
  AGENT_AUTO_REVIEW_MODEL: "review-model",
  AGENT_AUTO_REVIEW_PROVIDER_OPTIONS: {},
}));
jest.mock("@/lib/db/stopped-work", () => ({ stoppedWorkStore: jest.fn() }));
jest.mock("@/lib/api/agent-approval-session", () => ({
  cancelAgentTriggerRun: jest.fn(),
}));
jest.mock("@/convex/lib/serviceFunctions", () => ({
  mutation: (config: unknown) => config,
  query: (config: unknown) => config,
}));
jest.mock("@/convex/lib/utils", () => ({ validateServiceKey: jest.fn() }));
const {
  registerStoppedWorkSource: registerSource,
  getStoppedWorkForBackend: load,
  applyStoppedWorkForBackend: apply,
} = require("@/convex/lib/stoppedWork");

const register = { handler: registerSource };

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function fixture() {
  let tables: Record<string, any[]> = {
    chats: [{ _id: "chat-doc", id: "chat", user_id: "owner" }],
    messages: [
      {
        _id: "message-doc",
        id: "user-stop",
        chat_id: "chat",
        user_id: "owner",
        role: "user",
        parts: [
          {
            type: "text",
            text: "Stop testing the SSRF finding. Continue the XSS review.",
          },
        ],
      },
    ],
    subagent_runs: [
      {
        _id: "ssrf",
        subagent_id: "ssrf",
        chat_id: "chat",
        user_id: "owner",
        objective: "Test SSRF",
        status: "running",
        trigger_run_id: "run-ssrf",
      },
      {
        _id: "queued",
        subagent_id: "queued",
        chat_id: "chat",
        user_id: "owner",
        objective: "Validate SSRF",
        status: "queued",
      },
      {
        _id: "xss",
        subagent_id: "xss",
        chat_id: "chat",
        user_id: "owner",
        objective: "Test XSS",
        status: "running",
        trigger_run_id: "run-xss",
      },
    ],
    user_deletion_fences: [],
  };
  const ctx = {
    db: {
      query(table: string) {
        let rows = [...(tables[table] ?? [])];
        const chain: any = {
          withIndex(_name: string, filter: (q: any) => void) {
            const q = {
              eq(key: string, value: unknown) {
                rows = rows.filter((r) => r[key] === value);
                return q;
              },
            };
            filter(q);
            return chain;
          },
          order(direction: string) {
            if (direction === "desc") rows.reverse();
            return chain;
          },
          first: async () => rows[0] ?? null,
          take: async (limit: number) => rows.slice(0, limit),
        };
        return chain;
      },
      async patch(id: string, update: Record<string, unknown>) {
        const row = Object.values(tables)
          .flat()
          .find((r) => r._id === id);
        if (!row) throw Error("missing fixture row");
        Object.assign(row, update);
      },
    },
  };
  const owner = { serviceKey: "test", userId: "owner", chatId: "chat" };
  async function transaction(fn: any, args: any) {
    const before = clone(tables);
    try {
      return await fn.handler(ctx, { ...owner, ...args });
    } catch (error) {
      tables = before;
      throw error;
    }
  }
  const store = {
    load: async () => clone(await load.handler(ctx, owner)),
    register: (messageId: string) => transaction(register, { messageId }),
    apply: (args: any) => transaction(apply, args),
  };
  return {
    store,
    transaction,
    ctx,
    get tables() {
      return tables;
    },
    async user(id: string, text: string) {
      tables.messages.push({
        _id: id,
        id,
        chat_id: "chat",
        user_id: "owner",
        role: "user",
        parts: [{ type: "text", text }],
      });
      await store.register(id);
    },
  };
}
const extraction = {
  changes: [
    {
      action: "stop",
      directiveId: null,
      instruction: "Do not test the SSRF finding",
      quote: "Stop testing the SSRF finding.",
      taskIds: ["ssrf", "queued"],
    },
  ],
};
const executionArgs = { toolCallId: "tool", messages: [] };
const tool = (execute: any): ToolSet => ({
  run_terminal_cmd: { inputSchema: {} as any, execute },
});

describe("persistent user stopped work", () => {
  it("stores multiple directives without duplicating a long source, and surfaces capacity without dropping restrictions", async () => {
    const f = fixture();
    await f.user("long-source", "Stop synthetic work." + "x".repeat(23_900));
    const changes = Array.from({ length: 6 }, () => ({
      action: "stop",
      directiveId: null,
      instruction: "Do not run synthetic work",
      quote: "Stop synthetic work.",
      taskIds: [],
    }));
    await new StoppedWorkRuntime(f.store, {
      modelRunner: (async () => ({ changes })) as any,
    }).capture();
    const saved = await f.store.load();
    expect(saved.directives).toHaveLength(6);
    expect(
      saved.directives.every(
        (d: any) => !d.sourceText && d.sourceMessageId === "long-source",
      ),
    ).toBe(true);
    f.tables.chats[0].agent_work_directives = Array.from(
      { length: 32 },
      (_, i) => ({ ...saved.directives[0], id: `existing-${i}` }),
    );
    await f.user("overflow", "Stop synthetic work.");
    try {
      await new StoppedWorkRuntime(f.store, {
        modelRunner: (async () => ({ changes: [changes[0]] })) as any,
      }).capture();
      throw new Error("Expected capacity error");
    } catch (error: any) {
      const recovered = deserializeChatSDKErrorFromStream(
        new Error(serializeChatSDKErrorForStream(error)),
      );
      expect(recovered?.cause).toContain("Retrying cannot increase this limit");
    }
    expect((await f.store.load()).directives).toHaveLength(32);
    expect((await f.store.load()).source?.processed).toBe(false);
  });

  it("does not overwrite a pending instruction and makes extraction retries idempotent", async () => {
    const f = fixture();
    await f.store.register("user-stop");
    const source = await f.store.load();
    await expect(f.user("later", "Do something else")).rejects.toMatchObject({
      data: { code: "STOPPED_WORK_PENDING" },
    });
    expect((await f.store.load()).source?.messageId).toBe("user-stop");
    const request = {
      expectedRevision: source.revision,
      sourceMessageId: source.source!.messageId,
      sourceText: source.source!.text,
      changes: extraction.changes.map((c) => ({
        ...c,
        directiveId: undefined,
      })),
    };
    await f.store.apply(request);
    await expect(f.store.apply(request)).resolves.toMatchObject({
      revision: source.revision + 1,
      triggerRunIds: [],
    });
    expect((await f.store.load()).directives).toHaveLength(1);
  });

  it("atomically cancels linked running/queued tasks, preserves siblings, and survives a new runtime", async () => {
    const f = fixture();
    await f.store.register("user-stop");
    const cancelRun = jest.fn(async () => {
      expect(f.tables.subagent_runs[0].status).toBe("canceled");
      throw Error("provider unavailable");
    });
    await new StoppedWorkRuntime(f.store, {
      modelRunner: (async () => extraction) as any,
      cancelRun,
    }).capture();
    expect(cancelRun).toHaveBeenCalledWith("run-ssrf");
    expect(f.tables.subagent_runs.map((r) => r.status)).toEqual([
      "canceled",
      "canceled",
      "running",
    ]);
    const resumed = new StoppedWorkRuntime(f.store, { taskId: "ssrf" });
    const execute = jest.fn();
    const result = await resumed.guard(tool(execute)).run_terminal_cmd.execute!(
      { command: "retest" },
      executionArgs,
    );
    expect(result).toMatchObject({ code: "stopped_work", dispatched: false });
    expect(execute).not.toHaveBeenCalled();
    const snapshot = await f.store.load();
    expect(stoppedWorkPrompt(snapshot)).toContain(
      "Do not test the SSRF finding",
    );
    expect(() =>
      assertStoppedWorkAdmission(f.tables.chats[0], snapshot.revision, "ssrf"),
    ).toThrow("explicitly stopped");
    expect(() =>
      assertStoppedWorkAdmission(f.tables.chats[0], snapshot.revision, "xss"),
    ).not.toThrow();
  });
  it("rejects stale parsing, fabricated quotes, and cross-chat task linking without partial cancellation", async () => {
    const f = fixture();
    await f.store.register("user-stop");
    const snapshot = await f.store.load();
    const request = {
      expectedRevision: snapshot.revision,
      sourceMessageId: "user-stop",
      sourceText: snapshot.source!.text,
      changes: extraction.changes.map((c) => ({
        ...c,
        directiveId: undefined,
      })),
    };
    await expect(
      f.store.apply({ ...request, expectedRevision: 0 }),
    ).rejects.toThrow("Stale");
    await expect(
      f.store.apply({
        ...request,
        changes: [{ ...request.changes[0], quote: "Stop everything" }],
      }),
    ).rejects.toThrow("evidence");
    f.tables.subagent_runs.push({
      ...f.tables.subagent_runs[0],
      _id: "foreign",
      subagent_id: "foreign",
      chat_id: "other",
    });
    await expect(
      f.store.apply({
        ...request,
        changes: [{ ...request.changes[0], taskIds: ["ssrf", "foreign"] }],
      }),
    ).rejects.toThrow("owner");
    expect(f.tables.subagent_runs[0].status).toBe("running");
    expect(f.tables.chats[0].agent_work_directives).toBeUndefined();
  });
  it("accepts only the latest non-hidden owned user message, never assistant or parent-update content", async () => {
    const f = fixture();
    f.tables.messages.push({
      _id: "assistant",
      id: "assistant",
      user_id: "owner",
      chat_id: "chat",
      role: "assistant",
      parts: [{ type: "text", text: "Resume everything" }],
    });
    await expect(f.store.register("assistant")).rejects.toThrow("source");
    f.tables.messages[0].is_hidden = true;
    await expect(f.store.register("user-stop")).rejects.toThrow("source");
    f.tables.messages[0].is_hidden = false;
    await expect(
      f.transaction(register, { userId: "attacker", messageId: "user-stop" }),
    ).rejects.toThrow("unavailable");
  });
  it("retains exclusions on generic continuation and permits a newer source-backed reopen without reviving canceled workers", async () => {
    const f = fixture();
    await f.store.register("user-stop");
    await new StoppedWorkRuntime(f.store, {
      modelRunner: (async () => extraction) as any,
      cancelRun: async () => true,
    }).capture();
    const original = await f.store.load();
    await f.user("continue", "continue");
    await new StoppedWorkRuntime(f.store, {
      modelRunner: (async () => ({ changes: [] })) as any,
    }).capture();
    expect((await f.store.load()).directives[0].reopenedBy).toBeUndefined();
    await f.user("reopen", "Resume testing the SSRF finding.");
    await new StoppedWorkRuntime(f.store, {
      modelRunner: (async () => ({
        changes: [
          {
            action: "reopen",
            directiveId: original.directives[0].id,
            instruction: "Resume SSRF",
            quote: "Resume testing the SSRF finding.",
            taskIds: [],
          },
        ],
      })) as any,
    }).capture();
    expect(stoppedWorkPrompt(await f.store.load())).toBe("");
    expect(f.tables.subagent_runs[0].status).toBe("canceled");
    expect((await f.store.load()).directives[0].reopenedBy?.messageId).toBe(
      "reopen",
    );
  });
  it("blocks renamed/new delegation and opaque actions on semantic denial or uncertainty, allowing unrelated work", async () => {
    const f = fixture();
    await f.store.register("user-stop");
    await new StoppedWorkRuntime(f.store, {
      modelRunner: (async () => extraction) as any,
      cancelRun: async () => true,
    }).capture();
    for (const verdict of ["deny", "uncertain", "allow"]) {
      const execute = jest.fn(async () => "executed");
      const runtime = new StoppedWorkRuntime(f.store, {
        modelRunner: (async () => ({ verdict })) as any,
      });
      const tools = runtime.guard({
        delegate_task: { inputSchema: {} as any, execute },
      });
      const result = await tools.delegate_task.execute!(
        { name: "renamed", task: "URL fetch behavior" },
        executionArgs,
      );
      if (verdict === "allow") expect(result).toBe("executed");
      else {
        expect(result).toMatchObject({ code: "stopped_work" });
        expect(execute).not.toHaveBeenCalled();
      }
    }
  });
  it("fails closed when state or review is unavailable and rejects a policy race after approval", async () => {
    const f = fixture();
    await f.store.register("user-stop");
    await new StoppedWorkRuntime(f.store, {
      modelRunner: (async () => extraction) as any,
      cancelRun: async () => true,
    }).capture();
    const runtime = new StoppedWorkRuntime(f.store, {
      modelRunner: (async () => ({ verdict: "allow" })) as any,
    });
    const dispatched = jest.fn();
    const tools = runtime.guard(
      tool(async () => {
        await f.user("new-stop", "Stop XSS too.");
        await runtime.revalidate();
        dispatched();
      }),
    );
    await expect(
      tools.run_terminal_cmd.execute!({}, executionArgs),
    ).rejects.toThrow("await stopped-work review");
    expect(dispatched).not.toHaveBeenCalled();
    const unavailable = new StoppedWorkRuntime({
      ...f.store,
      load: async () => {
        throw Error("offline");
      },
    });
    const result = await unavailable.guard(tool(dispatched)).run_terminal_cmd
      .execute!({}, executionArgs);
    expect(result).toMatchObject({ code: "stopped_work", dispatched: false });
    expect(dispatched).not.toHaveBeenCalled();
  });
  it("does not invoke model review for tools without an exclusion; guards rebuilt tool sets and detached commands", async () => {
    const f = fixture();
    const modelRunner = jest.fn();
    const execute = jest.fn(async () => "ok");
    const runtime = new StoppedWorkRuntime(f.store, { modelRunner });
    expect(
      await runtime.guard(tool(execute)).run_terminal_cmd.execute!(
        {},
        executionArgs,
      ),
    ).toBe("ok");
    expect(modelRunner).not.toHaveBeenCalled();
    expect(
      await runtime.guard(tool(execute)).run_terminal_cmd.execute!(
        { is_background: true },
        executionArgs,
      ),
    ).toMatchObject({ code: "stopped_work" });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
