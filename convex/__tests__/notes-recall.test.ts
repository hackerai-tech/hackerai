import { beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("../lib/serviceFunctions", () => ({
  query: (config: unknown) => config,
  mutation: (config: unknown) => config,
}));
jest.mock("../lib/utils", () => ({ validateServiceKey: jest.fn() }));

// Recall's server lookup is routed to the real Convex handler below, so the
// Alpha/Beta journey exercises the query, project scoping and selection together.
const dbActions = { getNoteRecallCandidates: jest.fn<any>() };
jest.mock("@/lib/db/actions", () => dbActions);
const mockEvent = jest.fn();
jest.mock("@/lib/posthog/server", () => ({
  getPostHogBooleanFlagDecisionForUser: jest.fn(),
  phLogger: { event: (...args: unknown[]) => mockEvent(...args) },
}));

const notes = require("../notes") as typeof import("../notes");
const { buildRelevantNotesSection } =
  require("@/lib/notes/recall") as typeof import("@/lib/notes/recall");

type Doc = Record<string, any> & { _id: string; _creationTime: number };

const INDEXES: Record<string, string[]> = {
  by_note_id: ["note_id"],
  by_user_and_updated: ["user_id", "updated_at"],
  by_user_and_category_and_updated: ["user_id", "category", "updated_at"],
  by_user_and_target_and_updated: ["user_id", "target", "updated_at"],
  by_user_and_project_and_target_and_updated: [
    "user_id",
    "project_id",
    "target",
    "updated_at",
  ],
  by_user_and_project_and_target_and_category_and_updated: [
    "user_id",
    "project_id",
    "target",
    "category",
    "updated_at",
  ],
  by_chat_id: ["id"],
};

/** Minimal Convex-like DB: index equality/ranges, ordering, take and paginate. */
function createDb() {
  const tables: Record<string, Doc[]> = { notes: [], chats: [], projects: [] };
  let seq = 0;
  let reads = 0;
  const compare = (a: unknown, b: unknown) =>
    a === b ? 0 : a === undefined ? -1 : b === undefined ? 1 : a! < b! ? -1 : 1;

  const results = (rows: Doc[]) => {
    let ordered = rows;
    const api = {
      order(direction: "asc" | "desc") {
        if (direction === "desc") ordered = [...ordered].reverse();
        return api;
      },
      async take(n: number) {
        const page = ordered.slice(0, n);
        reads += page.length;
        return page;
      },
      async first() {
        reads += ordered.length ? 1 : 0;
        return ordered[0] ?? null;
      },
      async unique() {
        return ordered[0] ?? null;
      },
      async collect() {
        reads += ordered.length;
        return ordered;
      },
      async paginate({
        numItems,
        cursor,
      }: {
        numItems: number;
        cursor: string | null;
      }) {
        if (cursor !== null && !/^\d+$/.test(cursor))
          throw new Error("InvalidCursor");
        const start = cursor ? Number(cursor) : 0;
        const page = ordered.slice(start, start + numItems);
        reads += page.length;
        const end = start + page.length;
        return {
          page,
          isDone: end >= ordered.length,
          continueCursor: String(end),
        };
      },
      async *[Symbol.asyncIterator]() {
        for (const row of ordered) {
          reads++;
          yield row;
        }
      },
    };
    return api;
  };

  const db = {
    query(table: string) {
      return {
        withIndex(name: string, build: (q: any) => unknown) {
          const fields = INDEXES[name];
          const eq: [string, unknown][] = [];
          const ranges: [string, (value: unknown) => boolean][] = [];
          const q: any = {
            eq: (field: string, value: unknown) => (eq.push([field, value]), q),
            gte: (field: string, value: unknown) => (
              ranges.push([
                field,
                (v) => v !== undefined && compare(v, value) >= 0,
              ]),
              q
            ),
            lt: (field: string, value: unknown) => (
              ranges.push([
                field,
                (v) => v !== undefined && compare(v, value) < 0,
              ]),
              q
            ),
          };
          build(q);
          const rows = tables[table]
            .filter((doc) => eq.every(([f, v]) => doc[f] === v))
            .filter((doc) => ranges.every(([f, test]) => test(doc[f])))
            .sort(
              (a, b) =>
                fields.reduce((c, f) => c || compare(a[f], b[f]), 0) ||
                a._creationTime - b._creationTime,
            );
          return results(rows);
        },
        withSearchIndex(_name: string, build: (q: any) => unknown) {
          let terms: string[] = [];
          const eq: [string, unknown][] = [];
          const q: any = {
            search: (_field: string, text: string) => (
              (terms = text.toLowerCase().split(/\s+/).filter(Boolean)),
              q
            ),
            eq: (field: string, value: unknown) => (eq.push([field, value]), q),
          };
          build(q);
          return results(
            tables[table].filter(
              (doc) =>
                eq.every(([f, v]) => doc[f] === v) &&
                terms.some((term) => doc.content.toLowerCase().includes(term)),
            ),
          );
        },
      };
    },
    async get(id: string) {
      return (
        Object.values(tables)
          .flat()
          .find((doc) => doc._id === id) ?? null
      );
    },
    normalizeId(table: string, id: string) {
      return tables[table].some((doc) => doc._id === id) ? id : null;
    },
    async insert(table: string, doc: Record<string, unknown>) {
      const _id = `${table}:${++seq}`;
      tables[table].push({ ...doc, _id, _creationTime: seq });
      return _id;
    },
    async patch(id: string, fields: Record<string, unknown>) {
      const doc = Object.values(tables)
        .flat()
        .find((row) => row._id === id)!;
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) delete doc[key];
        else doc[key] = value;
      }
    },
  };
  return {
    ctx: { db } as any,
    tables,
    reads: () => reads,
    resetReads: () => (reads = 0),
  };
}

const run = (fn: unknown, ctx: unknown, args: Record<string, unknown>) =>
  (fn as { handler: (ctx: unknown, args: unknown) => Promise<any> }).handler(
    ctx,
    {
      serviceKey: "test",
      ...args,
    },
  );

describe("notes recall backend", () => {
  let db: ReturnType<typeof createDb>;
  let projectAlpha: string;
  let projectOther: string;

  const create = (args: Record<string, unknown>) =>
    run(notes.createNoteForBackend, db.ctx, {
      userId: "user-1",
      category: "general",
      ...args,
    });

  beforeEach(async () => {
    jest.clearAllMocks();
    db = createDb();
    projectAlpha = await db.ctx.db.insert("projects", { user_id: "user-1" });
    projectOther = await db.ctx.db.insert("projects", { user_id: "user-2" });
    await db.ctx.db.insert("chats", {
      id: "chat-alpha",
      user_id: "user-1",
      project_id: projectAlpha,
    });
    await db.ctx.db.insert("chats", {
      id: "chat-foreign",
      user_id: "user-2",
      project_id: projectOther,
    });
    dbActions.getNoteRecallCandidates.mockImplementation(
      (args: Record<string, unknown>) =>
        run(notes.getNoteRecallCandidatesForBackend, db.ctx, args),
    );
  });

  it("derives the project only from the caller's own chat", async () => {
    await create({ title: "Own", content: "x", chatId: "chat-alpha" });
    await create({
      title: "Foreign chat",
      content: "x",
      chatId: "chat-foreign",
    });
    const [own, foreign] = db.tables.notes;
    expect(own.project_id).toBe(projectAlpha);
    expect(foreign.project_id).toBeUndefined();
  });

  it("normalizes targets and rejects broadening or credential-bearing ones", async () => {
    await create({
      title: "A",
      content: "x",
      target: "HTTPS://Alpha.Example/",
    });
    expect(db.tables.notes[0].target).toBe("https://alpha.example");
    for (const target of [
      "*.alpha.example",
      "https://alpha.example/api",
      "https://u:p@alpha.example",
    ]) {
      const result = await create({ title: "B", content: "x", target });
      expect(result.success).toBe(false);
    }
    expect(db.tables.notes).toHaveLength(1);
  });

  it("keeps observed_at on edits and changes it only for a new observation", async () => {
    const { note_id } = await create({
      title: "IDOR",
      content: "old",
      category: "findings",
      target: "alpha.example",
      observedAt: Date.UTC(2026, 10, 3),
    });
    await run(notes.updateNoteForBackend, db.ctx, {
      userId: "user-1",
      noteId: note_id,
      content: "edited",
    });
    expect(db.tables.notes[0]).toMatchObject({
      content: "edited",
      observed_at: Date.UTC(2026, 10, 3),
    });
    await run(notes.updateNoteForBackend, db.ctx, {
      userId: "user-1",
      noteId: note_id,
      observedAt: Date.UTC(2026, 10, 10),
      target: null,
    });
    expect(db.tables.notes[0].observed_at).toBe(Date.UTC(2026, 10, 10));
    expect(db.tables.notes[0]).not.toHaveProperty("target");
  });

  it("reads full notes only for their owner, in safe continuation pages", async () => {
    const content = `${"😀".repeat(5)}tail`;
    const { note_id } = await create({ title: "Long", content });
    const other = await run(notes.getNoteForBackend, db.ctx, {
      userId: "user-2",
      noteId: note_id,
    });
    expect(other).toEqual({
      success: false,
      error: `Note '${note_id}' not found`,
    });

    // An offset inside a surrogate pair snaps back instead of emitting half a character.
    const page = await run(notes.getNoteForBackend, db.ctx, {
      userId: "user-1",
      noteId: note_id,
      offset: 3,
      maxChars: 3,
    });
    expect(page.note).toMatchObject({
      content_offset: 2,
      content: "😀",
      content_length: content.length,
    });
  });

  it("paginates compact summaries without losing or repeating notes", async () => {
    for (let i = 0; i < 7; i++) {
      await create({ title: `n${i}`, content: "x".repeat(400) });
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await run(notes.listNoteSummariesForBackend, db.ctx, {
        userId: "user-1",
        limit: 3,
        cursor,
      });
      expect(page.success).toBe(true);
      for (const note of page.notes) {
        expect(note.preview.length).toBeLessThanOrEqual(281);
        expect(note.preview_truncated).toBe(true);
        expect(note).not.toHaveProperty("content");
        seen.push(note.note_id);
      }
      cursor = page.next_cursor;
      expect(page.has_more).toBe(cursor !== undefined);
    } while (cursor);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  it("keeps scoped notes out of the legacy general-notes dump", async () => {
    await create({ title: "Legacy preference", content: "x" });
    await create({
      title: "Alpha only",
      content: "x",
      target: "alpha.example",
    });
    await create({ title: "Project only", content: "x", chatId: "chat-alpha" });
    const legacy = await run(notes.getNotesForBackend, db.ctx, {
      userId: "user-1",
      subscription: "pro",
    });
    expect(legacy.map((note: { title: string }) => note.title)).toEqual([
      "Legacy preference",
    ]);
  });

  it("recalls only the asked target plus applicable general context, within budget", async () => {
    await create({
      title: "Prefer read-only probes",
      content: "GET and HEAD first.",
    });
    await create({
      title: "Alpha invoice IDOR",
      content: "Invoice export returns other tenants' PDFs.",
      category: "findings",
      target: "alpha.example",
      observedAt: Date.UTC(2026, 10, 3),
    });
    await create({
      title: "Beta admin panel",
      content: "Exposed admin.",
      category: "findings",
      target: "beta.example",
    });
    // A targeted note is excluded for other targets even in the general category.
    await create({
      title: "Beta scope rules",
      content: "Weekend only.",
      target: "beta.example",
    });
    // Untargeted non-general notes need keyword relevance to the task.
    await create({
      title: "GraphQL batching trick",
      content: "Alias batching.",
      category: "methodology",
    });
    await create({
      title: "Other user's Alpha note",
      content: "x",
      target: "alpha.example",
      userId: "user-2",
    });
    await create({
      title: "Other project Alpha note",
      content: "x",
      target: "alpha.example",
      chatId: "chat-alpha",
    });

    const result = await buildRelevantNotesSection({
      userId: "user-1",
      scope: {
        taskText:
          "What do we know about https://alpha.example before I retest invoice export?",
      },
    });

    expect(result.section).toContain("Alpha invoice IDOR");
    expect(result.section).toContain(
      "target: alpha.example; observed 2026-11-03",
    );
    expect(result.section).toContain("Prefer read-only probes");
    expect(result.section).not.toMatch(/Beta|GraphQL|Other user|Other project/);
    expect(result).toMatchObject({ noteCount: 2, targetedCount: 1 });
    expect(result.tokenCount).toBeLessThanOrEqual(1_500);

    // Inside the owning project, its notes become eligible.
    const inProject = await buildRelevantNotesSection({
      userId: "user-1",
      scope: { taskText: "alpha.example status", projectId: projectAlpha },
    });
    expect(inProject.section).toContain("Other project Alpha note");
  });

  it("only honors a live project owned by the caller", async () => {
    await create({
      title: "Alpha project note",
      content: "x",
      target: "alpha.example",
      chatId: "chat-alpha",
    });
    const recall = (userId: string) =>
      run(notes.getNoteRecallCandidatesForBackend, db.ctx, {
        userId,
        projectId: projectAlpha,
        targets: ["alpha.example"],
      });
    expect(await recall("user-1")).toHaveLength(1);
    await db.ctx.db.patch(projectAlpha, { deletion_started_at: 1 });
    expect(await recall("user-1")).toEqual([]);
  });

  it("bounds candidate reads regardless of note volume", async () => {
    for (let i = 0; i < 300; i++) {
      await create({
        title: `g${i}`,
        content: "alpha invoice",
        target: i % 2 ? "alpha.example" : undefined,
      });
    }
    db.resetReads();
    await run(notes.getNoteRecallCandidatesForBackend, db.ctx, {
      userId: "user-1",
      targets: ["alpha.example", "https://alpha.example"],
      searchText: "alpha invoice",
    });
    expect(db.reads()).toBeLessThanOrEqual(6 * 2 + 15 + 25 + 10);
  });

  it("does not let newer notes from another project crowd out the current project", async () => {
    const projectBeta = await db.ctx.db.insert("projects", {
      user_id: "user-1",
    });
    await db.ctx.db.insert("chats", {
      id: "chat-beta",
      user_id: "user-1",
      project_id: projectBeta,
    });
    await create({
      title: "Current project Alpha note",
      content: "x",
      target: "alpha.example",
      chatId: "chat-alpha",
    });
    await create({ title: "Unprojected preference", content: "x" });
    for (let i = 0; i < 8; i++) {
      await create({
        title: `Other project Alpha ${i}`,
        content: "x",
        target: "alpha.example",
        chatId: "chat-beta",
      });
    }
    for (let i = 0; i < 30; i++) {
      await create({
        title: `Other project preference ${i}`,
        content: "x",
        chatId: "chat-beta",
      });
    }

    const candidates = await run(
      notes.getNoteRecallCandidatesForBackend,
      db.ctx,
      {
        userId: "user-1",
        projectId: projectAlpha,
        targets: ["alpha.example"],
      },
    );
    const titles = candidates.map((note: { title: string }) => note.title);
    expect(titles).toEqual(
      expect.arrayContaining([
        "Current project Alpha note",
        "Unprojected preference",
      ]),
    );
    expect(
      titles.some((title: string) => title.startsWith("Other project")),
    ).toBe(false);
  });

  it("bounds legacy metadata returned to tools", async () => {
    const { note_id } = await create({ title: "x", content: "body" });
    Object.assign(db.tables.notes[0], {
      title: "題".repeat(5_000),
      tags: Array.from({ length: 500 }, (_, i) => `${i}-${"t".repeat(500)}`),
    });
    const { note } = await run(notes.getNoteForBackend, db.ctx, {
      userId: "user-1",
      noteId: note_id,
    });
    expect(note.title.length).toBeLessThanOrEqual(201);
    expect(note.tags).toHaveLength(12);
    expect(note.tags.every((tag: string) => tag.length <= 65)).toBe(true);
  });
});
