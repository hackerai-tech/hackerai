/** @jest-environment node */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("../lib/serviceFunctions", () => ({
  mutation: jest.fn((config: any) => config),
  internalMutation: jest.fn((config: any) => config),
  query: jest.fn((config: any) => config),
}));
jest.mock("../lib/utils", () => ({ validateServiceKey: jest.fn() }));
jest.mock("../lib/suspensionGuards", () => ({
  assertUserCanAccessChatHistory: jest.fn(async () => undefined),
}));
jest.mock("../_generated/api", () => ({
  internal: { findingAgentRetests: { deleteForFinding: "deleteForFinding" } },
}));

type Row = { _id: string; [key: string]: any };
type Tables = Record<string, Row[]>;

/** Minimal in-memory Convex reader/writer for index equality/range reads. */
function createCtx(tables: Tables) {
  let nextId = 1;
  const query = (table: string) => ({
    withIndex: (_index: string, build?: (q: any) => any) => {
      const filters: Array<(row: Row) => boolean> = [];
      const q: any = {
        eq: (field: string, value: unknown) => {
          filters.push((row) => row[field] === value);
          return q;
        },
        gte: (field: string, value: number) => {
          filters.push((row) => row[field] >= value);
          return q;
        },
      };
      build?.(q);
      let direction: "asc" | "desc" = "asc";
      const rows = () => {
        const matched = (tables[table] ?? []).filter((row) =>
          filters.every((filter) => filter(row)),
        );
        return direction === "desc" ? [...matched].reverse() : matched;
      };
      const result: any = {
        order: (d: "asc" | "desc") => {
          direction = d;
          return result;
        },
        first: async () => rows()[0] ?? null,
        unique: async () => {
          const all = rows();
          if (all.length > 1) throw new Error("not unique");
          return all[0] ?? null;
        },
        take: async (n: number) => rows().slice(0, n),
      };
      return result;
    },
  });
  const find = (id: string) =>
    Object.values(tables)
      .flat()
      .find((row) => row._id === id) ?? null;
  return {
    db: {
      query,
      get: async (id: string) => find(id),
      insert: async (table: string, value: Record<string, unknown>) => {
        const row = { _id: `${table}:${nextId++}`, ...value };
        (tables[table] ??= []).push(row);
        return row._id;
      },
      patch: async (id: string, value: Record<string, unknown>) => {
        Object.assign(find(id)!, value);
      },
      delete: async (id: string) => {
        for (const [table, rows] of Object.entries(tables))
          tables[table] = rows.filter((row) => row._id !== id);
      },
    },
    scheduler: { runAfter: jest.fn() },
  } as any;
}

const seed = (): Tables => ({
  findings: [
    {
      _id: "f1",
      finding_id: "finding-1",
      user_id: "user-1",
      chat_id: "chat-1",
      target: "https://app.example.test",
      updated_at: 100,
    },
    {
      _id: "f2",
      finding_id: "finding-other",
      user_id: "user-2",
      chat_id: "chat-2",
      target: "https://x.test",
      updated_at: 100,
    },
  ],
  chats: [
    {
      _id: "c1",
      id: "chat-1",
      user_id: "user-1",
      title: "Demo shop fixture scan",
      active_trigger_run_id: "run_1",
    },
    {
      _id: "c2",
      id: "chat-2",
      user_id: "user-2",
      title: "Other",
      active_trigger_run_id: "run_2",
    },
  ],
  user_deletion_fences: [],
  finding_agent_retest_runs: [],
});

const start = (overrides: Record<string, unknown> = {}) => ({
  serviceKey: "k",
  userId: "user-1",
  chatId: "chat-1",
  findingId: "finding-1",
  assistantMessageId: "message-1",
  triggerRunId: "run_1",
  expectedUpdatedAt: 100,
  ...overrides,
});

const result = (overrides: Record<string, unknown> = {}) => ({
  outcome: "reproduced" as const,
  summary: "Tester still read another account's invoice.",
  reproduction_steps: ["Load own invoice", "Load other invoice"],
  expected_result: "403 for the other account's invoice",
  observed_result: "Own invoice 200; other invoice 200 owned by usr_victim_a",
  evidence_refs: [],
  limitations: [],
  ...overrides,
});

const complete = (overrides: Record<string, unknown> = {}) => ({
  serviceKey: "k",
  userId: "user-1",
  chatId: "chat-1",
  findingId: "finding-1",
  assistantMessageId: "message-1",
  triggerRunId: "run_1",
  result: result(),
  retainedEvidenceRefs: [],
  ...overrides,
});

describe("Agent finding retest records", () => {
  let mod: typeof import("../findingAgentRetests");
  let tables: Tables;
  let ctx: any;
  const startRun = (args = start()) =>
    (mod.startForBackend as any).handler(ctx, args);
  const completeRun = (args = complete()) =>
    (mod.completeForBackend as any).handler(ctx, args);
  const history = () =>
    (mod.getHistoryForBackend as any).handler(ctx, {
      serviceKey: "k",
      userId: "user-1",
      findingId: "finding-1",
    });
  const chat = () => tables.chats.find((row) => row.id === "chat-1")!;
  const runs = () => tables.finding_agent_retest_runs;

  beforeEach(async () => {
    mod = await import("../findingAgentRetests");
    tables = seed();
    ctx = createCtx(tables);
  });

  it("starts only for the owner's finding in its source chat at the read revision", async () => {
    expect(
      await startRun(start({ findingId: "finding-other", chatId: "chat-2" })),
    ).toMatchObject({ success: false, error: "not_found" });
    expect(await startRun(start({ chatId: "chat-2" }))).toMatchObject({
      success: false,
      error: "not_found",
    });
    tables.user_deletion_fences.push({ _id: "fence", user_id: "user-1" });
    expect(await startRun()).toMatchObject({ error: "not_found" });
    tables.user_deletion_fences = [];
    chat().deletion_started_at = 1;
    expect(await startRun()).toMatchObject({ error: "not_found" });
    delete chat().deletion_started_at;
    expect(await startRun(start({ expectedUpdatedAt: 99 }))).toMatchObject({
      success: false,
      error: "conflict",
    });
    expect(runs()).toHaveLength(0);
  });

  it("rechecks access on completed-result retries after chat deletion begins", async () => {
    expect(await startRun()).toMatchObject({ success: true });
    expect(await completeRun()).toMatchObject({ success: true });
    chat().deletion_started_at = 10;
    expect(await completeRun()).toMatchObject({
      success: false,
      error: "not_found",
    });
  });

  it("binds the record to the active run that started it", async () => {
    expect(await startRun(start({ triggerRunId: "run_old" }))).toMatchObject({
      error: "not_active",
    });
    chat().canceled_at = 5;
    expect(await startRun()).toMatchObject({ error: "not_active" });
    delete chat().canceled_at;
    // Web Agent requests bind to the chat's resumable stream instead.
    expect(await startRun(start({ triggerRunId: undefined }))).toMatchObject({
      error: "not_active",
    });
    chat().active_stream_id = "stream-1";
    expect(
      await startRun(
        start({ triggerRunId: undefined, assistantMessageId: "web" }),
      ),
    ).toMatchObject({ success: true });
    expect(runs()[0]).toMatchObject({
      stream_id: "stream-1",
      status: "running",
    });
    expect(runs()[0].trigger_run_id).toBeUndefined();
  });

  it("deduplicates a retried start and snapshots the finding", async () => {
    const first = await startRun();
    const retry = await startRun();
    expect(first).toMatchObject({ success: true, duplicate: false });
    expect(retry).toEqual({ ...first, duplicate: true });
    expect(runs()).toHaveLength(1);
    expect(runs()[0]).toMatchObject({
      user_id: "user-1",
      chat_id: "chat-1",
      assistant_message_id: "message-1",
      trigger_run_id: "run_1",
      finding_updated_at: 100,
      target: "https://app.example.test",
    });
    // A second response in the same live run can't start a parallel retest.
    expect(
      await startRun(start({ assistantMessageId: "message-2" })),
    ).toMatchObject({ error: "busy" });
  });

  it("saves one immutable assessment; only an identical retry succeeds", async () => {
    await startRun();
    const saved = await completeRun();
    expect(saved).toMatchObject({ success: true, duplicate: false });
    expect(await completeRun()).toMatchObject({
      success: true,
      duplicate: true,
    });
    expect(
      await completeRun(
        complete({
          result: result({
            outcome: "not_reproduced",
            limitations: ["One pair only"],
          }),
        }),
      ),
    ).toMatchObject({ success: false, error: "conflict" });
    expect(runs()[0]).toMatchObject({
      status: "finished",
      outcome: "reproduced",
    });
    expect(await startRun()).toMatchObject({ error: "already_finished" });
    // The finding itself is never changed by a retest.
    expect(tables.findings[0]).toMatchObject({ updated_at: 100 });
    expect(tables.findings[0].status).toBeUndefined();
  });

  it("rejects completion from another response or run", async () => {
    await startRun();
    expect(
      await completeRun(complete({ assistantMessageId: "message-2" })),
    ).toMatchObject({ error: "not_found" });
    expect(
      await completeRun(complete({ triggerRunId: "run_2" })),
    ).toMatchObject({ error: "not_found" });
    expect(await completeRun(complete({ chatId: "chat-2" }))).toMatchObject({
      error: "not_found",
    });
    expect(runs()[0].status).toBe("running");
  });

  it("validates bounded, redacted results server-side", async () => {
    await startRun();
    expect(
      await completeRun(
        complete({ result: result({ outcome: "not_reproduced" }) }),
      ),
    ).toMatchObject({ error: "validation" });
    expect(
      await completeRun(
        complete({
          result: result({
            observed_result: "Cookie: session=4f9a8b7c6d5e4f3a2b1c",
          }),
        }),
      ),
    ).toMatchObject({ error: "validation" });
    expect(
      await completeRun(complete({ retainedEvidenceRefs: ["/not-submitted"] })),
    ).toMatchObject({ error: "validation" });
    expect(runs()[0].status).toBe("running");
  });

  it("shows an ended run as inconclusive and never accepts a late result", async () => {
    await startRun();
    expect((await history()).retests[0]).toMatchObject({ status: "running" });
    chat().active_trigger_run_id = undefined;
    const view = (await history()).retests[0];
    expect(view).toMatchObject({
      status: "finished",
      outcome: "inconclusive",
      interrupted: true,
    });
    expect(await completeRun()).toMatchObject({ error: "interrupted" });
    expect(runs()[0]).toMatchObject({
      status: "finished",
      outcome: "inconclusive",
      interrupted: true,
    });
    // A replacement run with the old ID can't revive it.
    chat().active_trigger_run_id = "run_1";
    expect((await history()).retests[0]).toMatchObject({ interrupted: true });
    expect(await completeRun()).toMatchObject({ error: "interrupted" });
  });

  it("finalizes as inconclusive when the report changed during the retest", async () => {
    await startRun();
    tables.findings[0].updated_at = 101;
    expect(await completeRun()).toMatchObject({ error: "conflict" });
    expect(runs()[0]).toMatchObject({
      status: "finished",
      outcome: "inconclusive",
      interrupted: true,
    });
  });

  it("interrupts an older unfinished record when a new run starts", async () => {
    await startRun();
    chat().active_trigger_run_id = "run_3";
    expect(
      await startRun(
        start({ assistantMessageId: "message-2", triggerRunId: "run_3" }),
      ),
    ).toMatchObject({ success: true });
    expect(runs()[0]).toMatchObject({
      interrupted: true,
      outcome: "inconclusive",
    });
    expect(runs()[1]).toMatchObject({ status: "running" });
  });

  it("returns newest-first history for the owner only", async () => {
    await startRun();
    await completeRun();
    const read = await history();
    expect(read).toMatchObject({
      available: true,
      finding: { chat_title: "Demo shop fixture scan", updated_at: 100 },
    });
    expect(read.retests[0]).toMatchObject({
      status: "finished",
      outcome: "reproduced",
      assistant_message_id: "message-1",
      reproduction_steps: ["Load own invoice", "Load other invoice"],
    });
    expect(
      await (mod.getHistoryForBackend as any).handler(ctx, {
        serviceKey: "k",
        userId: "user-2",
        findingId: "finding-1",
      }),
    ).toEqual({ available: false });
  });

  it("deletes a chat's retests in batches without touching other users", async () => {
    for (let i = 0; i < 51; i++)
      runs().push({
        _id: `r${i}`,
        user_id: "user-1",
        chat_id: "chat-1",
        finding_id: "finding-1",
      });
    runs().push({
      _id: "other",
      user_id: "user-2",
      chat_id: "chat-1",
      finding_id: "finding-other",
    });
    expect(
      await mod.deleteFindingAgentRetestsForChatBatch(ctx, "user-1", "chat-1"),
    ).toBe(true);
    expect(
      await mod.deleteFindingAgentRetestsForChatBatch(ctx, "user-1", "chat-1"),
    ).toBe(false);
    expect(runs().map((row) => row._id)).toEqual(["other"]);
  });
});
