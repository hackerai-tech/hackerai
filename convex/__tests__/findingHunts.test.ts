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
  internal: { findingHunts: { deleteForFinding: "deleteForFinding" } },
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
      severity: "high",
      status: "active",
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
      title: "Invoice API authz review",
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
  finding_variant_hunts: [],
});

const provenance = (overrides: Record<string, unknown> = {}) => ({
  serviceKey: "k",
  userId: "user-1",
  chatId: "chat-1",
  findingId: "finding-1",
  assistantMessageId: "message-1",
  triggerRunId: "run_1",
  ...overrides,
});

const candidate = (overrides: Record<string, unknown> = {}) => ({
  candidate_key: "invoice-pdf",
  surface: "GET /api/invoices/{id}/pdf",
  rationale: "Uses the same invoice loader without an owner check.",
  outcome: "reproduced" as const,
  evidence_basis: "runtime_check" as const,
  reproduction_steps: ["Own PDF as tester A", "Tester B's PDF as tester A"],
  expected_result: "403 for tester B's PDF",
  observed_result: "200 with tester B's PDF",
  evidence_refs: [],
  limitations: [],
  ...overrides,
});

describe("Finding variant hunt records", () => {
  let mod: typeof import("../findingHunts");
  let tables: Tables;
  let ctx: any;
  const start = (overrides: Record<string, unknown> = {}) =>
    (mod.startForBackend as any).handler(ctx, {
      ...provenance(overrides),
      expectedUpdatedAt: 100,
      ...overrides,
    });
  const record = (
    candidateOverrides: Record<string, unknown> = {},
    overrides: Record<string, unknown> = {},
  ) =>
    (mod.recordCandidateForBackend as any).handler(ctx, {
      ...provenance(overrides),
      candidate: candidate(candidateOverrides),
      retainedEvidenceRefs: [],
      ...overrides,
    });
  const complete = (overrides: Record<string, unknown> = {}) =>
    (mod.completeForBackend as any).handler(ctx, {
      ...provenance(overrides),
      summary: "Two sibling endpoints share the ownership gap.",
      limitations: ["Export needs an admin role that was not available."],
      ...overrides,
    });
  const history = (userId = "user-1") =>
    (mod.getHistoryForBackend as any).handler(ctx, {
      serviceKey: "k",
      userId,
      findingId: "finding-1",
    });
  const chat = () => tables.chats.find((row) => row.id === "chat-1")!;
  const hunts = () => tables.finding_variant_hunts;

  beforeEach(async () => {
    mod = await import("../findingHunts");
    tables = seed();
    ctx = createCtx(tables);
  });

  it("starts only for the owner's finding in its source chat at the read revision", async () => {
    expect(
      await start({ findingId: "finding-other", chatId: "chat-2" }),
    ).toMatchObject({ success: false, error: "not_found" });
    expect(await start({ chatId: "chat-2" })).toMatchObject({
      error: "not_found",
    });
    tables.user_deletion_fences.push({ _id: "fence", user_id: "user-1" });
    expect(await start()).toMatchObject({ error: "not_found" });
    tables.user_deletion_fences = [];
    chat().deletion_started_at = 1;
    expect(await start()).toMatchObject({ error: "not_found" });
    delete chat().deletion_started_at;
    expect(await start({ expectedUpdatedAt: 99 })).toMatchObject({
      error: "conflict",
    });
    expect(hunts()).toHaveLength(0);
  });

  it("binds to the exact active run and deduplicates a retried start", async () => {
    expect(await start({ triggerRunId: "run_old" })).toMatchObject({
      error: "not_active",
    });
    chat().canceled_at = 5;
    expect(await start()).toMatchObject({ error: "not_active" });
    delete chat().canceled_at;
    const first = await start();
    expect(first).toMatchObject({ success: true, duplicate: false });
    expect(await start()).toEqual({ ...first, duplicate: true });
    expect(hunts()).toHaveLength(1);
    expect(hunts()[0]).toMatchObject({
      user_id: "user-1",
      chat_id: "chat-1",
      assistant_message_id: "message-1",
      trigger_run_id: "run_1",
      finding_updated_at: 100,
      candidates: [],
    });
    // A second response in the same live run can't start a parallel hunt.
    expect(await start({ assistantMessageId: "message-2" })).toMatchObject({
      error: "busy",
    });
  });

  it("saves candidates individually, immutable per key, and keeps the seed unchanged", async () => {
    await start();
    expect(await record()).toMatchObject({
      success: true,
      candidate_count: 1,
      duplicate: false,
    });
    expect(await record()).toMatchObject({ success: true, duplicate: true });
    expect(
      await record({ observed_result: "Different observation" }),
    ).toMatchObject({ success: false, error: "conflict" });
    expect(
      await record({
        candidate_key: "invoice-export",
        surface: "POST /api/invoices/export",
        outcome: "inconclusive",
        evidence_basis: "runtime_check",
        limitations: ["Needs an admin role"],
      }),
    ).toMatchObject({ success: true, candidate_count: 2 });
    // A runtime check can also rule a surface out.
    expect(
      await record({
        candidate_key: "invoice-attachments",
        surface: "GET /api/invoices/{id}/attachments/{file}",
        outcome: "ruled_out",
        authorized_control_succeeded: true,
        observed_result: "200 for own attachment; 404 for tester B's",
        limitations: ["One pair of accounts"],
      }),
    ).toMatchObject({ success: true, candidate_count: 3 });
    expect(hunts()[0].candidates[2]).toMatchObject({
      outcome: "ruled_out",
      evidence_basis: "runtime_check",
      authorized_control_succeeded: true,
    });
    expect(hunts()[0].candidates[2]).not.toHaveProperty("evidence_status");
    expect(hunts()[0].candidates.map((c: any) => c.outcome)).toEqual([
      "reproduced",
      "inconclusive",
      "ruled_out",
    ]);
    expect(await complete()).toMatchObject({
      success: true,
      duplicate: false,
      counts: { reproduced: 1, inconclusive: 1, ruled_out: 1 },
    });
    expect(await complete()).toMatchObject({ success: true, duplicate: true });
    expect(await complete({ summary: "Something else" })).toMatchObject({
      error: "conflict",
    });
    // A saved candidate retry stays a success; a new one can't be added.
    expect(await record()).toMatchObject({ success: true, duplicate: true });
    expect(await record({ candidate_key: "invoice-history" })).toMatchObject({
      error: "already_finished",
    });
    expect(tables.findings[0]).toMatchObject({
      updated_at: 100,
      severity: "high",
      status: "active",
    });
    expect(tables.findings).toHaveLength(2);
  });

  it("keeps saved candidates when the run stops and refuses late writes", async () => {
    await start();
    await record();
    expect((await history()).hunts[0]).toMatchObject({ status: "running" });
    chat().active_trigger_run_id = undefined;
    const view = (await history()).hunts[0];
    expect(view).toMatchObject({ status: "finished", interrupted: true });
    expect(view.candidates).toHaveLength(1);
    expect(view.candidates[0]).not.toHaveProperty("content_key");
    expect(await record({ candidate_key: "invoice-history" })).toMatchObject({
      error: "interrupted",
    });
    expect(await complete()).toMatchObject({ error: "interrupted" });
    expect(hunts()[0]).toMatchObject({ status: "finished", interrupted: true });
    expect(hunts()[0].candidates).toHaveLength(1);
    // A replacement run with the old ID can't revive it.
    chat().active_trigger_run_id = "run_1";
    expect((await history()).hunts[0]).toMatchObject({ interrupted: true });
    // A new hunt from a new message starts fresh.
    expect(await start({ assistantMessageId: "message-2" })).toMatchObject({
      success: true,
      duplicate: false,
    });
  });

  it("stops early without saving when the seed report changes mid-hunt", async () => {
    await start();
    await record();
    tables.findings[0].updated_at = 101;
    expect(await record({ candidate_key: "invoice-history" })).toMatchObject({
      error: "conflict",
    });
    expect(hunts()[0]).toMatchObject({ interrupted: true });
    expect(hunts()[0].candidates).toHaveLength(1);
  });

  it("rejects writes from another response, run or chat", async () => {
    await start();
    expect(await record({}, { assistantMessageId: "message-2" })).toMatchObject(
      { error: "not_found" },
    );
    expect(await record({}, { triggerRunId: "run_2" })).toMatchObject({
      error: "not_found",
    });
    expect(await complete({ chatId: "chat-2" })).toMatchObject({
      error: "not_found",
    });
    expect(hunts()[0].candidates).toHaveLength(0);
    expect(hunts()[0].status).toBe("running");
  });

  it("validates honesty, bounds and secrets server-side before writing", async () => {
    await start();
    // Source-only suspicion can't be reported as reproduced.
    expect(
      await record({ evidence_basis: "source_review_only" }),
    ).toMatchObject({ error: "validation" });
    // The seed finding's evidence vocabulary is not a candidate method.
    expect(
      await record({ evidence_basis: "runtime_reproduced" }),
    ).toMatchObject({ error: "validation" });
    expect(
      await record({ observed_result: "Cookie: session=4f9a8b7c6d5e4f3a2b1c" }),
    ).toMatchObject({ error: "validation" });
    expect(
      await record({ outcome: "ruled_out", limitations: [] }),
    ).toMatchObject({ error: "validation" });
    expect(
      await record({}, { retainedEvidenceRefs: ["/not-submitted"] }),
    ).toMatchObject({ error: "validation" });
    expect(await complete({ limitations: [] })).toMatchObject({
      error: "validation",
    });
    expect(hunts()[0].candidates).toHaveLength(0);
  });

  it("saves blocked access as inconclusive, never as a runtime rule-out", async () => {
    await start();
    const editorPreview = {
      candidate_key: "editor-preview",
      surface: "GET /api/invoices/{id}/editor-preview",
      outcome: "ruled_out",
      observed_result: "403 for own and tester B's invoice; no editor role",
      limitations: ["No editor account available"],
    };
    for (const authorized_control_succeeded of [undefined, false]) {
      const result = await record({
        ...editorPreview,
        authorized_control_succeeded,
      });
      expect(result).toMatchObject({ success: false, error: "validation" });
      expect(result.message).toMatch(/inconclusive/);
    }
    expect(hunts()[0].candidates).toHaveLength(0);

    expect(
      await record({
        ...editorPreview,
        outcome: "inconclusive",
        authorized_control_succeeded: false,
      }),
    ).toMatchObject({ success: true, candidate_count: 1 });
    // A source review that shows the control needs no runtime access.
    expect(
      await record({
        ...editorPreview,
        candidate_key: "editor-preview-source",
        evidence_basis: "source_review_only",
        observed_result: "Handler loads the invoice by id and owner_id",
      }),
    ).toMatchObject({ success: true, candidate_count: 2 });
    expect(hunts()[0].candidates[0]).toMatchObject({
      outcome: "inconclusive",
      authorized_control_succeeded: false,
    });
    expect(hunts()[0].candidates[1]).not.toHaveProperty(
      "authorized_control_succeeded",
    );
    // The control claim is part of the saved content: changing it on retry
    // conflicts instead of silently matching.
    expect(
      await record({
        ...editorPreview,
        outcome: "inconclusive",
        authorized_control_succeeded: true,
      }),
    ).toMatchObject({ success: false, error: "conflict" });
    expect(
      await record({
        ...editorPreview,
        outcome: "inconclusive",
        authorized_control_succeeded: false,
      }),
    ).toMatchObject({ success: true, duplicate: true });
    expect(hunts()[0].candidates).toHaveLength(2);
  });

  it("caps candidates per hunt and hunts per hour", async () => {
    await start();
    for (let i = 0; i < 8; i++)
      expect(await record({ candidate_key: `c${i}` })).toMatchObject({
        success: true,
      });
    expect(await record({ candidate_key: "c8" })).toMatchObject({
      error: "limit_reached",
    });
    tables.finding_variant_hunts = Array.from({ length: 20 }, (_, i) => ({
      _id: `h${i}`,
      user_id: "user-1",
      chat_id: "chat-1",
      finding_id: `finding-${i}`,
      status: "finished",
      started_at: Date.now(),
      candidates: [],
    }));
    expect(await start({ assistantMessageId: "message-9" })).toMatchObject({
      error: "rate_limited",
    });
  });

  it("returns newest-first history for the owner only", async () => {
    await start();
    await record();
    const read = await history();
    expect(read).toMatchObject({
      available: true,
      finding: { chat_title: "Invoice API authz review", updated_at: 100 },
    });
    expect(read.hunts[0].candidates[0]).toMatchObject({
      surface: "GET /api/invoices/{id}/pdf",
      outcome: "reproduced",
    });
    expect(await history("user-2")).toEqual({ available: false });
  });

  it("deletes a chat's hunts in batches without touching other users", async () => {
    for (let i = 0; i < 51; i++)
      hunts().push({
        _id: `h${i}`,
        user_id: "user-1",
        chat_id: "chat-1",
        finding_id: "finding-1",
      });
    hunts().push({
      _id: "other",
      user_id: "user-2",
      chat_id: "chat-1",
      finding_id: "finding-other",
    });
    expect(
      await mod.deleteFindingHuntsForChatBatch(ctx, "user-1", "chat-1"),
    ).toBe(true);
    expect(
      await mod.deleteFindingHuntsForChatBatch(ctx, "user-1", "chat-1"),
    ).toBe(false);
    expect(hunts().map((row) => row._id)).toEqual(["other"]);
  });

  it("continues deleting a removed finding's hunts in scheduled batches", async () => {
    for (let i = 0; i < 51; i++)
      hunts().push({
        _id: `h${i}`,
        user_id: "user-1",
        finding_id: "finding-1",
        started_at: i,
      });
    const args = { findingId: "finding-1", userId: "user-1" };
    await (mod.deleteForFinding as any).handler(ctx, args);
    expect(ctx.scheduler.runAfter).toHaveBeenCalledWith(
      0,
      "deleteForFinding",
      args,
    );
    await (mod.deleteForFinding as any).handler(ctx, args);
    expect(hunts()).toHaveLength(0);
  });
});
