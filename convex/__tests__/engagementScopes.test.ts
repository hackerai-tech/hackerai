import {
  initializeBranchedScope,
  beginUserMessage,
  commitUserMessage,
  getForBackend,
  getRetrySource,
  edit,
  claimClarification,
  deleteScopeBatch,
} from "../engagementScopes";
import { createScopeRuntime } from "../../lib/engagement-scope/runtime";
import { getConvexClient } from "../../lib/db/convex-client";

jest.mock("../lib/serviceFunctions", () => ({
  mutation: (c: unknown) => c,
  query: (c: unknown) => c,
}));
jest.mock("../lib/suspensionGuards", () => ({
  assertUserCanAccessChatHistory: jest.fn(),
}));
jest.mock("../lib/utils", () => ({ validateServiceKey: jest.fn() }));
jest.mock("../../lib/db/convex-client", () => ({ getConvexClient: jest.fn() }));
const call = (fn: any, ctx: any, args: any) => fn.handler(ctx, args);
const auth = { serviceKey: "test", chatId: "chat", userId: "owner" };
const policy = {
  rules: [
    {
      target: "*.example.test",
      effect: "allow" as const,
      activity: "active_testing" as const,
    },
  ],
  restrictions: [],
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function database() {
  let next = 0;
  const rows = new Map<string, any>();
  const insert = async (table: string, value: any) => {
    const _id = `${table}:${++next}`;
    rows.set(_id, { ...clone(value), _id, _creationTime: next, table });
    return _id;
  };
  const ctx: any = {
    auth: { getUserIdentity: async () => ({ subject: "owner" }) },
    db: {
      insert,
      patch: async (id: string, update: any) => {
        if (!rows.has(id)) throw new Error("missing");
        rows.set(id, { ...rows.get(id), ...clone(update) });
      },
      delete: async (id: string) => {
        rows.delete(id);
      },
      query: (table: string) => ({
        withIndex: (_index: string, build: any) => {
          const equals: [string, unknown][] = [];
          const q = {
            eq: (k: string, v: unknown) => {
              equals.push([k, v]);
              return q;
            },
          };
          build(q);
          const found = () =>
            [...rows.values()]
              .filter(
                (r) =>
                  r.table === table && equals.every(([k, v]) => r[k] === v),
              )
              .map((r) => clone(r));
          return {
            unique: async () => found()[0] ?? null,
            take: async (n: number) => found().slice(0, n),
          };
        },
      }),
    },
  };
  return { ctx, rows, insert };
}

describe("persisted engagement scope", () => {
  let db: ReturnType<typeof database>;
  async function message(id = "m1", overrides: any = {}) {
    return db.insert("messages", {
      id,
      chat_id: "chat",
      user_id: "owner",
      role: "user",
      parts: [{ type: "text", text: "Test *.example.test" }],
      ...overrides,
    });
  }
  async function apply(id = "m1", clarification = "") {
    const began = await call(beginUserMessage, db.ctx, {
      ...auth,
      messageId: id,
    });
    await call(commitUserMessage, db.ctx, {
      ...auth,
      messageId: id,
      expectedRevision: began.revision,
      policy,
      clarification,
      unavailable: false,
    });
    return call(getForBackend, db.ctx, auth);
  }
  beforeEach(async () => {
    db = database();
    await db.insert("chats", { id: "chat", user_id: "owner" });
    (getConvexClient as jest.Mock).mockReturnValue({
      query: (_ref: unknown, args: any) => call(getForBackend, db.ctx, args),
      mutation: (_ref: unknown, args: any) =>
        call(claimClarification, db.ctx, args),
    });
  });
  it("blocks copied transcript regeneration immediately after branching and accepts an explicit scope edit", async () => {
    await initializeBranchedScope(db.ctx, "chat", "owner");
    const runtime = createScopeRuntime("owner", "chat");
    await runtime.prompt();
    expect((await runtime.checkUrl("https://api.example.test")).outcome).toBe(
      "deny",
    );
    await expect(runtime.checkTool("run_terminal_cmd")).rejects.toThrow(
      "No active targets",
    );
    await call(edit, db.ctx, { chatId: "chat", expectedRevision: 0, policy });
    await runtime.prompt();
    expect((await runtime.checkUrl("https://api.example.test")).outcome).toBe(
      "allow",
    );
  });
  it("persists a real message once and reloads the same policy in parent and restarted child", async () => {
    await message();
    const saved = await apply();
    expect(await call(getRetrySource, db.ctx, auth)).toBeNull();
    const retry = await call(beginUserMessage, db.ctx, {
      ...auth,
      messageId: "m1",
    });
    expect(retry.complete).toBe(true);
    expect(retry.revision).toBe(saved.revision);
    const parent = createScopeRuntime("owner", "chat");
    const child = createScopeRuntime("owner", "chat", true);
    expect(await parent.prompt()).toContain("*.example.test");
    expect(await child.prompt()).toContain("*.example.test");
    expect((await child.checkUrl("https://api.example.test")).outcome).toBe(
      "allow",
    );
    expect((await child.checkUrl("https://example.test")).outcome).toBe("deny");
    // This new runtime has no transcript or in-memory parent state.
    expect(
      (
        await createScopeRuntime("owner", "chat", true).checkUrl(
          "https://api.example.test",
        )
      ).outcome,
    ).toBe("allow");
  });
  it.each([
    { role: "assistant" },
    { is_hidden: true },
    { source_message_id: "copied-original" },
    { user_id: "someone-else" },
    { chat_id: "other" },
  ])("rejects non-authoritative sources %j", async (overrides) => {
    await message("m1", overrides);
    await expect(
      call(beginUserMessage, db.ctx, { ...auth, messageId: "m1" }),
    ).rejects.toThrow("genuine user message");
    expect(
      [...db.rows.values()].filter((r) => r.table === "engagement_scopes"),
    ).toHaveLength(0);
  });
  it("holds actions on a pending update and prevents losing a concurrent narrowing instruction", async () => {
    await message();
    await apply();
    await message("m2");
    await message("m3");
    await call(beginUserMessage, db.ctx, { ...auth, messageId: "m2" });
    const child = createScopeRuntime("owner", "chat", true);
    expect((await child.checkUrl("https://api.example.test")).outcome).toBe(
      "unavailable",
    );
    await expect(child.checkTool("run_terminal_cmd")).rejects.toThrow(
      "temporarily unavailable",
    );
    await expect(
      call(beginUserMessage, db.ctx, { ...auth, messageId: "m3" }),
    ).rejects.toThrow("previous scope update");
  });
  it("recovers an abandoned narrowing source before allowing the next message", async () => {
    await message();
    await apply();
    await message("m2", {
      parts: [{ type: "text", text: "Exclude api.example.test" }],
    });
    await message("m3", { parts: [{ type: "text", text: "continue" }] });
    await call(beginUserMessage, db.ctx, { ...auth, messageId: "m2" });
    const retryId = await call(getRetrySource, db.ctx, auth);
    expect(retryId).toBe("m2");
    const retry = await call(beginUserMessage, db.ctx, {
      ...auth,
      messageId: retryId,
    });
    expect(retry.sourceText).toBe("Exclude api.example.test");
    const narrowed = {
      rules: [
        ...policy.rules,
        { target: "api.example.test", effect: "deny", activity: "all_contact" },
      ],
      restrictions: [],
    };
    await call(commitUserMessage, db.ctx, {
      ...auth,
      messageId: retryId,
      expectedRevision: retry.revision,
      policy: narrowed,
      clarification: "",
      unavailable: false,
    });
    const next = await call(beginUserMessage, db.ctx, {
      ...auth,
      messageId: "m3",
    });
    expect(next.current.rules).toEqual(narrowed.rules);
    await call(commitUserMessage, db.ctx, {
      ...auth,
      messageId: "m3",
      expectedRevision: next.revision,
      policy: narrowed,
      clarification: "",
      unavailable: false,
    });
    expect(
      (
        await createScopeRuntime("owner", "chat").checkUrl(
          "https://api.example.test",
        )
      ).outcome,
    ).toBe("deny");
    expect(await call(getRetrySource, db.ctx, auth)).toBeNull();
  });
  it("refreshes child URL checks after narrowing and rejects stale edits and stale model dispatch", async () => {
    await message();
    const saved = await apply();
    const child = createScopeRuntime("owner", "chat", true);
    await child.prompt();
    const narrowed = {
      ...policy,
      rules: [
        ...policy.rules,
        {
          target: "api.example.test",
          effect: "deny",
          activity: "active_testing",
        },
      ],
    };
    await call(edit, db.ctx, {
      chatId: "chat",
      expectedRevision: saved.revision,
      policy: narrowed,
    });
    expect((await child.checkUrl("https://api.example.test")).outcome).toBe(
      "deny",
    );
    await expect(child.checkTool("run_terminal_cmd")).rejects.toThrow(
      "Saved scope changed",
    );
    await child.prompt();
    await expect(child.checkTool("run_terminal_cmd")).resolves.toBeUndefined();
    await expect(
      call(edit, db.ctx, {
        chatId: "chat",
        expectedRevision: saved.revision,
        policy,
      }),
    ).rejects.toThrow("Scope changed");
  });
  it("claims a clarification once across parent restarts and never from a child", async () => {
    await message();
    await apply("m1", "Which additional host?");
    const child = createScopeRuntime("owner", "chat", true);
    expect(await child.prompt()).not.toContain("Ask once");
    const first = await createScopeRuntime("owner", "chat").prompt();
    expect(first).toContain("Ask once");
    expect(await createScopeRuntime("owner", "chat").prompt()).not.toContain(
      "Ask once",
    );
  });
  it("retains valid rules on extraction failure and allows retry without a new authorization", async () => {
    await message();
    await apply();
    await message("m2");
    const began = await call(beginUserMessage, db.ctx, {
      ...auth,
      messageId: "m2",
    });
    await call(commitUserMessage, db.ctx, {
      ...auth,
      messageId: "m2",
      expectedRevision: began.revision,
      policy: { rules: [], restrictions: [] },
      clarification: "",
      unavailable: true,
    });
    const saved = await call(getForBackend, db.ctx, auth);
    expect(saved.rules).toEqual(policy.rules);
    expect(saved.status).toBe("unavailable");
    const retry = await call(beginUserMessage, db.ctx, {
      ...auth,
      messageId: "m2",
    });
    expect(retry.complete).toBe(false);
    expect(retry.current.rules).toEqual(policy.rules);
    await apply("m2");
    expect((await call(getForBackend, db.ctx, auth)).status).toBe("ready");
  });
  it("does not restore an older extraction over a genuine UI edit", async () => {
    await message();
    const began = await call(beginUserMessage, db.ctx, {
      ...auth,
      messageId: "m1",
    });
    await call(edit, db.ctx, {
      chatId: "chat",
      expectedRevision: began.revision,
      policy: { rules: [], restrictions: [] },
    });
    expect(
      await call(commitUserMessage, db.ctx, {
        ...auth,
        messageId: "m1",
        expectedRevision: began.revision,
        policy,
        clarification: "",
        unavailable: false,
      }),
    ).toBe(false);
    expect((await call(getForBackend, db.ctx, auth)).rules).toEqual([]);
  });
  it("rejects cross-owner reads and holds on a missing expected policy", async () => {
    await message();
    await apply();
    await expect(
      call(getForBackend, db.ctx, { ...auth, userId: "other" }),
    ).rejects.toThrow("Chat unavailable");
    const row = [...db.rows.values()].find(
      (r) => r.table === "engagement_scopes",
    );
    db.rows.delete(row._id);
    expect(
      (
        await createScopeRuntime("owner", "chat").checkUrl(
          "https://api.example.test",
        )
      ).outcome,
    ).toBe("unavailable");
  });
  it("deletes policy and source records with the chat", async () => {
    await message();
    await apply();
    expect(await deleteScopeBatch(db.ctx, "chat")).toBe(false);
    expect(
      [...db.rows.values()].filter((r) =>
        r.table.startsWith("engagement_scope"),
      ),
    ).toHaveLength(0);
  });
});
