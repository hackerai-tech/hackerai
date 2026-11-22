/** @jest-environment node */
jest.mock("../lib/serviceFunctions", () => ({
  mutation: (config: unknown) => config,
  query: (config: unknown) => config,
}));
import * as functions from "../egressAbuseReview";
import { database } from "../../__mocks__/abuse-database";

const KEY = "synthetic-egress-review-key";
const USER = "user_subject";
const CHAT = "chat_1";
const RUN = "run_parent1";
const MINUTE_MS = 60_000;
const BURST = { burstStart: 1_000 * MINUTE_MS, burstEnd: 1_001 * MINUTE_MS };
const ciphertext = "v1.k1.nonce.tag.data";
const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.E2B_EGRESS_ABUSE_REVIEW_ENABLED = "true";
  process.env.CONVEX_EGRESS_ABUSE_REVIEW_SERVICE_KEY = KEY;
  process.env.CONVEX_SERVICE_ROLE_KEY = "synthetic-main-key";
  process.env.ABUSE_EVIDENCE_KEYS = JSON.stringify({
    active: "k1",
    keys: { k1: "ab".repeat(32) },
  });
});
afterEach(() => {
  process.env = { ...originalEnv };
});

/** The shared indexed store plus the async iteration Convex queries support. */
function reviewDatabase() {
  const ctx = database();
  const query = ctx.db.query.bind(ctx.db);
  (ctx.db as any).query = (table: string) => {
    const chain: any = query(table);
    chain[Symbol.asyncIterator] = async function* () {
      yield* await chain.take(Number.POSITIVE_INFINITY);
    };
    return chain;
  };
  return ctx;
}

const invoke = (name: keyof typeof functions, ctx: any, args: any) =>
  (functions[name] as any).handler(ctx, args);
const runArgs = {
  serviceKey: KEY,
  userId: USER,
  chatId: CHAT,
  runId: RUN,
  ...BURST,
};

const command = (
  toolCallId: string,
  value: string,
  state = "output-available",
) => ({
  type: "tool-run_terminal_cmd",
  toolCallId,
  state,
  input: { action: "exec", command: value, brief: "x", is_background: false },
  output: {
    result: { processStarted: true, output: "TOOL OUTPUT MUST NOT BE READ" },
  },
});

async function seedChat(ctx: any, overrides: Record<string, unknown> = {}) {
  await ctx.db.insert("chats", { id: CHAT, user_id: USER, ...overrides });
  await ctx.db.insert("messages", {
    id: "m-user-1",
    chat_id: CHAT,
    user_id: USER,
    role: "user",
    parts: [{ type: "text", text: "Please test my staging host." }],
  });
  await ctx.db.insert("messages", {
    id: "m-system",
    chat_id: CHAT,
    user_id: USER,
    role: "system",
    parts: [{ type: "text", text: "SYSTEM TEXT" }],
  });
  await ctx.db.insert("messages", {
    id: "m-hidden",
    chat_id: CHAT,
    user_id: USER,
    role: "user",
    is_hidden: true,
    parts: [{ type: "text", text: "HIDDEN TEXT" }],
  });
  await ctx.db.insert("messages", {
    id: "m-assistant",
    chat_id: CHAT,
    user_id: USER,
    role: "assistant",
    trigger_run_id: RUN,
    generation_started_at: BURST.burstStart - 5 * MINUTE_MS,
    generation_time_ms: 10 * MINUTE_MS,
    parts: [
      { type: "reasoning", text: "REASONING TEXT" },
      command("call-1", "nmap -sV 203.0.113.5"),
      {
        type: "tool-run_terminal_cmd",
        toolCallId: "call-view",
        state: "output-available",
        input: { action: "view", session: "s1" },
      },
      command("call-2", "curl https://example.net", "output-error"),
      {
        ...command("call-denied", "DENIED COMMAND"),
        output: { result: { approvalDenied: true } },
      },
      {
        type: "tool-interact_terminal_session",
        toolCallId: "call-3",
        state: "output-available",
        input: { action: "send", session: "s1", input: "PRIVATE INPUT\n" },
      },
      {
        type: "tool-interact_terminal_session",
        toolCallId: "call-4",
        state: "output-available",
        input: { action: "wait", session: "s1", timeout: 5 },
      },
      { type: "text", text: "ASSISTANT TEXT" },
    ],
  });
}

describe("authorization", () => {
  it("rejects every function without the dedicated review key", async () => {
    const ctx = reviewDatabase();
    await seedChat(ctx);
    const main = { serviceKey: "synthetic-main-key" };
    await expect(
      invoke("matchRun", ctx, { ...runArgs, ...main, runKind: "parent" }),
    ).rejects.toThrow("Unauthorized");
    await expect(
      invoke("readRunEvidence", ctx, { ...runArgs, ...main }),
    ).rejects.toThrow("Unauthorized");
    await expect(
      invoke("readAccountActivity", ctx, {
        ...main,
        userId: USER,
        reference: "AB-00000000-0000-0000-0000-000000000000",
        ...BURST,
      }),
    ).rejects.toThrow("Unauthorized");
    await expect(
      invoke("recordCase", ctx, {
        ...main,
        reference: "AB-00000000-0000-0000-0000-000000000000",
        digest: "a".repeat(64),
        ciphertext,
      }),
    ).rejects.toThrow("Unauthorized");
    delete process.env.CONVEX_EGRESS_ABUSE_REVIEW_SERVICE_KEY;
    await expect(
      invoke("matchRun", ctx, { ...runArgs, runKind: "parent" }),
    ).rejects.toThrow("Unauthorized");
    process.env.CONVEX_EGRESS_ABUSE_REVIEW_SERVICE_KEY = KEY;
    delete process.env.E2B_EGRESS_ABUSE_REVIEW_ENABLED;
    await expect(
      invoke("matchRun", ctx, { ...runArgs, runKind: "parent" }),
    ).rejects.toThrow("Unauthorized");
  });
});

describe("matchRun", () => {
  it.each([
    ["owned by another account", { user_id: "someone_else" }],
    ["deleted", { deletion_started_at: 1 }],
  ])("reports a chat %s as unavailable", async (_label, overrides) => {
    const ctx = reviewDatabase();
    await seedChat(ctx, overrides);
    await expect(
      invoke("matchRun", ctx, { ...runArgs, runKind: "parent" }),
    ).resolves.toEqual({ status: "unavailable" });
  });

  it("places a run by its persisted generation time", async () => {
    const ctx = reviewDatabase();
    await seedChat(ctx);
    await expect(
      invoke("matchRun", ctx, { ...runArgs, runKind: "parent" }),
    ).resolves.toEqual({ status: "overlaps" });
    // The same run long before the burst cannot have caused it.
    const later = {
      burstStart: BURST.burstStart + 60 * MINUTE_MS,
      burstEnd: BURST.burstEnd + 60 * MINUTE_MS,
    };
    await expect(
      invoke("matchRun", ctx, { ...runArgs, ...later, runKind: "parent" }),
    ).resolves.toEqual({ status: "disjoint" });
    // A linked run with nothing persisted cannot be placed or excluded.
    await expect(
      invoke("matchRun", ctx, {
        ...runArgs,
        runId: "run_other",
        runKind: "parent",
      }),
    ).resolves.toEqual({ status: "unknown" });
  });

  it("does not call a run disjoint when older chat history was not read", async () => {
    const ctx = reviewDatabase();
    // Older rows of the same run, beyond the bounded scan, could place it in
    // the burst even though its visible rows start after it.
    for (let index = 0; index < 130; index++)
      await ctx.db.insert("messages", {
        id: `old-${index}`,
        chat_id: CHAT,
        user_id: USER,
        role: "assistant",
        trigger_run_id: RUN,
        generation_started_at: BURST.burstStart,
        generation_time_ms: 1,
        parts: [],
      });
    await seedChat(ctx);
    const earlier = {
      burstStart: BURST.burstStart - 60 * MINUTE_MS,
      burstEnd: BURST.burstEnd - 60 * MINUTE_MS,
    };
    await expect(
      invoke("matchRun", ctx, { ...runArgs, ...earlier, runKind: "parent" }),
    ).resolves.toEqual({ status: "unknown" });
  });

  it("places subagent links by their own run record", async () => {
    const ctx = reviewDatabase();
    await seedChat(ctx);
    await ctx.db.insert("subagent_runs", {
      user_id: USER,
      chat_id: CHAT,
      parent_trigger_run_id: RUN,
      trigger_run_id: "run_child",
      status: "running",
      created_at: BURST.burstStart - MINUTE_MS,
    });
    await expect(
      invoke("matchRun", ctx, {
        ...runArgs,
        runId: "run_child",
        runKind: "subagent",
      }),
    ).resolves.toEqual({ status: "overlaps" });
  });
});

describe("readRunEvidence", () => {
  it("returns only user text and completed terminal inputs of the exact run", async () => {
    const ctx = reviewDatabase();
    await seedChat(ctx);
    await ctx.db.insert("messages", {
      id: "m-other-run",
      chat_id: CHAT,
      user_id: USER,
      role: "assistant",
      trigger_run_id: "run_other",
      generation_started_at: BURST.burstStart,
      generation_time_ms: 1,
      parts: [command("other", "OTHER RUN COMMAND")],
    });
    const result = await invoke("readRunEvidence", ctx, runArgs);
    expect(result.status).toBe("ok");
    expect(result.userMessages).toEqual([
      {
        messageId: "m-user-1",
        text: "Please test my staging host.",
        truncated: false,
      },
    ]);
    expect(result.commands).toEqual([
      {
        messageId: "m-assistant",
        toolCallId: "call-1",
        tool: "run_terminal_cmd",
        text: "nmap -sV 203.0.113.5",
        truncated: false,
      },
    ]);
    // Denied and errored commands and interactive input are not evidence.
    expect(result.coverage).toMatchObject({
      incompleteToolCalls: 3,
      historyTruncated: false,
      runActive: false,
    });
    const serialized = JSON.stringify(result);
    for (const excluded of [
      "TOOL OUTPUT",
      "DENIED COMMAND",
      "PRIVATE INPUT",
      "SYSTEM TEXT",
      "HIDDEN TEXT",
      "REASONING TEXT",
      "ASSISTANT TEXT",
      "OTHER RUN COMMAND",
    ])
      expect(serialized).not.toContain(excluded);
  });

  it("abstains when a subagent of the run may have shared the workspace", async () => {
    const ctx = reviewDatabase();
    await seedChat(ctx);
    await ctx.db.insert("subagent_runs", {
      user_id: USER,
      chat_id: CHAT,
      parent_trigger_run_id: RUN,
      trigger_run_id: "run_child",
      status: "completed",
      created_at: BURST.burstStart - MINUTE_MS,
      completed_at: BURST.burstEnd,
    });
    await expect(invoke("readRunEvidence", ctx, runArgs)).resolves.toEqual({
      status: "unavailable",
      reason: "subagent_overlap",
    });
  });

  it("abstains when another root run of the account is active", async () => {
    const ctx = reviewDatabase();
    await seedChat(ctx);
    await ctx.db.insert("chats", {
      id: "chat_2",
      user_id: USER,
      active_trigger_run_id: "run_concurrent",
    });
    await expect(invoke("readRunEvidence", ctx, runArgs)).resolves.toEqual({
      status: "unavailable",
      reason: "concurrent_run",
    });
  });

  it("reports a truncated scan rather than implying the chat was complete", async () => {
    const ctx = reviewDatabase();
    for (let index = 0; index < 130; index++)
      await ctx.db.insert("messages", {
        id: `old-${index}`,
        chat_id: CHAT,
        user_id: USER,
        role: "user",
        parts: [{ type: "text", text: `old ${index}` }],
      });
    await seedChat(ctx);
    const result = await invoke("readRunEvidence", ctx, runArgs);
    expect(result.coverage.historyTruncated).toBe(true);
    expect(result.coverage.rawReads).toBeLessThanOrEqual(120);
  });
});

describe("readAccountActivity", () => {
  // A recent burst: account activity is never read for an old window.
  const burstStart = (Math.floor(Date.now() / MINUTE_MS) - 30) * MINUTE_MS;
  const burst = { burstStart, burstEnd: burstStart + MINUTE_MS };
  const HOUR_MS = 60 * MINUTE_MS;
  const reference = "AB-0123abcd-0000-4000-8000-00000000abcd";
  const activityArgs = { serviceKey: KEY, userId: USER, reference, ...burst };
  const read = (ctx: any, overrides: Record<string, unknown> = {}) =>
    invoke("readAccountActivity", ctx, { ...activityArgs, ...overrides });

  /** One chat with a user request and a run that started a command at `at`. */
  async function seedActivity(
    ctx: any,
    chatId: string,
    at: number,
    options: {
      user?: string;
      chat?: Record<string, unknown>;
      commandText?: string;
    } = {},
  ) {
    const user = options.user ?? USER;
    await ctx.db.insert("chats", {
      id: chatId,
      user_id: user,
      update_time: at + MINUTE_MS,
      _creationTime: at - HOUR_MS,
      ...options.chat,
    });
    await ctx.db.insert("messages", {
      id: `${chatId}-user`,
      chat_id: chatId,
      user_id: user,
      role: "user",
      update_time: at - MINUTE_MS,
      _creationTime: at - MINUTE_MS,
      parts: [{ type: "text", text: `REQUEST ${chatId}` }],
    });
    await ctx.db.insert("messages", {
      id: `${chatId}-assistant`,
      chat_id: chatId,
      user_id: user,
      role: "assistant",
      trigger_run_id: `run_${chatId}`,
      generation_started_at: at,
      generation_time_ms: MINUTE_MS,
      update_time: at + MINUTE_MS,
      _creationTime: at + MINUTE_MS,
      parts: [
        { type: "reasoning", text: "REASONING TEXT" },
        command(`call-${chatId}`, options.commandText ?? `COMMAND ${chatId}`),
        { type: "text", text: "ASSISTANT TEXT" },
      ],
    });
  }

  it("returns only owned chats whose runs started commands in the window, without other content", async () => {
    const ctx = reviewDatabase();
    // Text-only chat: its user text is never read out.
    await ctx.db.insert("chats", {
      id: "chat_text",
      user_id: USER,
      update_time: burstStart - HOUR_MS,
      _creationTime: burstStart - 2 * HOUR_MS,
    });
    await ctx.db.insert("messages", {
      id: "text-only",
      chat_id: "chat_text",
      user_id: USER,
      role: "user",
      update_time: burstStart - HOUR_MS,
      _creationTime: burstStart - HOUR_MS,
      parts: [{ type: "text", text: "UNCORROBORATED TEXT" }],
    });
    await seedActivity(ctx, "chat_deleted", burstStart - 3 * HOUR_MS, {
      chat: { deletion_started_at: 1 },
    });
    await seedActivity(ctx, "chat_main", burstStart - 2 * HOUR_MS);
    await ctx.db.insert("messages", {
      id: "hidden",
      chat_id: "chat_main",
      user_id: USER,
      role: "user",
      is_hidden: true,
      update_time: burstStart - HOUR_MS,
      _creationTime: burstStart - HOUR_MS,
      parts: [{ type: "text", text: "HIDDEN TEXT" }],
    });
    await ctx.db.insert("messages", {
      id: "system",
      chat_id: "chat_main",
      user_id: USER,
      role: "system",
      update_time: burstStart - HOUR_MS,
      _creationTime: burstStart - HOUR_MS,
      parts: [{ type: "text", text: "SYSTEM TEXT" }],
    });
    // Written after the burst: it cannot have preceded it.
    await ctx.db.insert("messages", {
      id: "after",
      chat_id: "chat_main",
      user_id: USER,
      role: "user",
      update_time: burstStart + 5 * MINUTE_MS,
      _creationTime: burstStart + 5 * MINUTE_MS,
      parts: [{ type: "text", text: "LATER TEXT" }],
    });
    // A run that started after the burst ended.
    await ctx.db.insert("messages", {
      id: "later-run",
      chat_id: "chat_main",
      user_id: USER,
      role: "assistant",
      trigger_run_id: "run_later",
      generation_started_at: burstStart + 10 * MINUTE_MS,
      generation_time_ms: MINUTE_MS,
      update_time: burstStart + 11 * MINUTE_MS,
      _creationTime: burstStart + 11 * MINUTE_MS,
      parts: [command("call-later", "LATER COMMAND")],
    });
    // Another account's chat, and its row placed under this account's chat.
    await seedActivity(ctx, "chat_other", burstStart - HOUR_MS, {
      user: "someone_else",
    });
    await ctx.db.insert("messages", {
      id: "foreign",
      chat_id: "chat_main",
      user_id: "someone_else",
      role: "user",
      update_time: burstStart - HOUR_MS,
      _creationTime: burstStart - HOUR_MS,
      parts: [{ type: "text", text: "FOREIGN TEXT" }],
    });

    const result = await read(ctx);
    expect(result).toMatchObject({
      status: "ok",
      windowStart: burstStart - 24 * HOUR_MS,
      windowEnd: burst.burstEnd + MINUTE_MS,
      coverage: {
        chatsScanned: 2,
        chatsWithoutCommands: 1,
        chatsOmitted: 0,
        scanTruncated: false,
      },
    });
    expect(result.chats).toEqual([
      {
        chatId: "chat_main",
        runIds: ["run_chat_main"],
        userMessages: [
          {
            messageId: "chat_main-user",
            text: "REQUEST chat_main",
            truncated: false,
          },
        ],
        commands: [
          {
            messageId: "chat_main-assistant",
            toolCallId: "call-chat_main",
            tool: "run_terminal_cmd",
            text: "COMMAND chat_main",
            truncated: false,
          },
        ],
        coverage: expect.objectContaining({
          historyTruncated: false,
          incompleteToolCalls: 0,
        }),
      },
    ]);
    const serialized = JSON.stringify(result);
    for (const excluded of [
      "UNCORROBORATED TEXT",
      "HIDDEN TEXT",
      "SYSTEM TEXT",
      "REASONING TEXT",
      "ASSISTANT TEXT",
      "TOOL OUTPUT",
      "LATER TEXT",
      "LATER COMMAND",
      "FOREIGN TEXT",
      "chat_other",
      "chat_deleted",
    ])
      expect(serialized).not.toContain(excluded);
  });

  it("marks a chat incomplete when it has history before the window", async () => {
    const ctx = reviewDatabase();
    await ctx.db.insert("messages", {
      id: "older",
      chat_id: "chat_main",
      user_id: USER,
      role: "user",
      update_time: burstStart - 30 * HOUR_MS,
      _creationTime: burstStart - 30 * HOUR_MS,
      parts: [{ type: "text", text: "OLDER SCOPE TEXT" }],
    });
    await seedActivity(ctx, "chat_main", burstStart - HOUR_MS);
    const result = await read(ctx);
    expect(result.chats[0].coverage.historyTruncated).toBe(true);
    expect(JSON.stringify(result)).not.toContain("OLDER SCOPE TEXT");
  });

  it("reads nothing once the window's case exists", async () => {
    const ctx = reviewDatabase();
    await seedActivity(ctx, "chat_main", burstStart - HOUR_MS);
    await invoke("recordCase", ctx, {
      serviceKey: KEY,
      reference,
      digest: "d".repeat(64),
      ciphertext,
    });
    await expect(read(ctx)).resolves.toEqual({ status: "case_exists" });
  });

  it("returns nothing for an account being deleted", async () => {
    const ctx = reviewDatabase();
    await seedActivity(ctx, "chat_main", burstStart - HOUR_MS);
    await ctx.db.insert("user_deletion_fences", { user_id: USER });
    await expect(read(ctx)).resolves.toEqual({ status: "unavailable" });
  });

  it.each([
    ["older than a day", -25 * HOUR_MS],
    ["in the future", 40 * MINUTE_MS],
  ])("rejects a burst %s", async (_label, shift) => {
    const ctx = reviewDatabase();
    await expect(
      read(ctx, {
        burstStart: burstStart + shift,
        burstEnd: burst.burstEnd + shift,
      }),
    ).rejects.toThrow("Invalid burst window");
  });

  it("bounds the chats it scans and returns, and reports what it left out", async () => {
    const ctx = reviewDatabase();
    // Twenty-one chats updated in the window, oldest first.
    for (let index = 0; index < 21; index++)
      await seedActivity(
        ctx,
        `chat_${String(index).padStart(2, "0")}`,
        burstStart - (21 - index) * HOUR_MS,
      );
    const result = await read(ctx);
    expect(result.coverage).toEqual({
      chatsScanned: 20,
      chatsWithoutCommands: 0,
      chatsOmitted: 17,
      scanTruncated: true,
    });
    // The chats whose commands started closest to the burst.
    expect(result.chats.map((chat: any) => chat.chatId)).toEqual([
      "chat_20",
      "chat_19",
      "chat_18",
    ]);
  });

  it("stops reading a long chat and reports it as truncated", async () => {
    const ctx = reviewDatabase();
    for (let index = 0; index < 100; index++)
      await ctx.db.insert("messages", {
        id: `filler-${index}`,
        chat_id: "chat_main",
        user_id: USER,
        role: "user",
        update_time: burstStart - 3 * HOUR_MS + index,
        _creationTime: burstStart - 3 * HOUR_MS + index,
        parts: [{ type: "text", text: `filler ${index}` }],
      });
    await seedActivity(ctx, "chat_main", burstStart - HOUR_MS);
    const result = await read(ctx);
    expect(result.chats[0].coverage).toMatchObject({
      rawReads: 80,
      historyTruncated: true,
    });
  });
});

describe("recordCase", () => {
  const reference = "AB-0123abcd-0000-4000-8000-00000000abcd";
  const caseArgs = {
    serviceKey: KEY,
    reference,
    digest: "d".repeat(64),
    ciphertext,
  };

  it("creates one new operator case and never overwrites a reviewed one", async () => {
    const ctx = reviewDatabase();
    await expect(invoke("recordCase", ctx, caseArgs)).resolves.toEqual({
      outcome: "created",
    });
    expect(ctx.tables.abuse_cases).toEqual([
      expect.objectContaining({
        reference,
        kind: "abuse",
        status: "new",
        evidenceHold: false,
        ciphertext,
      }),
    ]);
    expect(ctx.tables.abuse_events).toEqual([
      expect.objectContaining({
        actor: "egress_abuse_review",
        kind: "received",
      }),
    ]);
    // An operator starts reviewing; a later burst in the same window retries.
    const row = ctx.tables.abuse_cases[0];
    Object.assign(row, { status: "reviewing", revision: 3 });
    await expect(
      invoke("recordCase", ctx, {
        ...caseArgs,
        ciphertext: "v1.k1.newer.evidence.value",
      }),
    ).resolves.toEqual({ outcome: "existing" });
    expect(ctx.tables.abuse_cases).toHaveLength(1);
    expect(ctx.tables.abuse_cases[0]).toMatchObject({
      status: "reviewing",
      revision: 3,
      ciphertext,
    });
    expect(ctx.tables.abuse_events).toHaveLength(1);
    // Never a notice, restriction or outbound message.
    for (const table of [
      "user_suspensions",
      "abuse_notifications",
      "abuse_responses",
      "local_sandbox_tokens",
    ])
      expect(ctx.tables[table] ?? []).toHaveLength(0);
  });

  it.each([
    ["plaintext evidence", { ciphertext: "user ran nmap against a target" }],
    ["an unknown encryption key", { ciphertext: "v1.k9.nonce.tag.data" }],
    ["a malformed reference", { reference: "AB-not-a-reference" }],
    ["a malformed digest", { digest: "xyz" }],
  ])("rejects %s", async (_label, overrides) => {
    const ctx = reviewDatabase();
    await expect(
      invoke("recordCase", ctx, { ...caseArgs, ...overrides }),
    ).rejects.toThrow();
    expect(ctx.tables.abuse_cases ?? []).toHaveLength(0);
  });
});
