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
      normalizeId: (table: string, id: string) =>
        (tables[table] ?? []).some((row) => row._id === id) ? id : null,
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
  } as any;
}

const recipe = (owner = "usr_victim_a") => ({
  version: 1,
  title: "Invoice IDOR",
  origin: "https://app.example.test",
  timeout_ms: 8000,
  credentials: [{ name: "tester_token", label: "Tester", placement: "bearer" }],
  baselines: [
    {
      label: "Own",
      method: "GET",
      path: "/api/invoices/2",
      credential: "tester_token",
      headers: [],
      expect: {
        status: 200,
        json: [{ json_path: "owner_id", equals: "usr_tester_b" }],
        body_contains: [],
      },
    },
  ],
  probe: {
    label: "Victim",
    method: "GET",
    path: "/api/invoices/1",
    credential: "tester_token",
    headers: [],
    vulnerable: {
      status: 200,
      json: [{ json_path: "owner_id", equals: owner }],
      body_contains: [],
    },
    not_reproduced: { statuses: [403, 404] },
  },
});

const seed = (): Tables => ({
  findings: [
    {
      _id: "f1",
      finding_id: "finding-1",
      user_id: "user-1",
      chat_id: "chat-1",
      title: "IDOR",
      target: "https://app.example.test",
    },
    {
      _id: "f2",
      finding_id: "finding-other",
      user_id: "user-2",
      chat_id: "chat-2",
      title: "Other",
      target: "https://x.test",
    },
  ],
  chats: [
    {
      _id: "c1",
      id: "chat-1",
      user_id: "user-1",
      title: "Scan",
      sandbox_type: "desktop-env",
    },
    { _id: "c2", id: "chat-2", user_id: "user-2", title: "Other" },
  ],
  user_deletion_fences: [],
  finding_retest_recipes: [],
  finding_retest_runs: [],
});

const base = { serviceKey: "k", userId: "user-1", findingId: "finding-1" };
const steps = [
  {
    kind: "baseline" as const,
    index: 0,
    status: 200,
    bytes: 20,
    body_sha256: "b".repeat(64),
    duration_ms: 4,
    error: "none" as const,
    matched: true,
    checks: [true],
  },
];

describe("finding retest persistence", () => {
  let mod: typeof import("../findingRetests");
  beforeEach(async () => {
    jest.restoreAllMocks();
    mod = await import("../findingRetests");
  });

  const save = (ctx: any, expectedVersion: number, value: unknown = recipe()) =>
    (mod.saveRecipeForBackend as any).handler(ctx, {
      ...base,
      expectedVersion,
      recipe: value,
      source: "user",
    });
  const start = (ctx: any, requestId: string, recipeVersion = 1) =>
    (mod.startRunForBackend as any).handler(ctx, {
      ...base,
      requestId,
      recipeVersion,
      reviewedSandbox: "desktop-env",
    });
  const finish = (ctx: any, runId: string, requestId: string) =>
    (mod.finishRunForBackend as any).handler(ctx, {
      serviceKey: "k",
      userId: "user-1",
      runId,
      requestId,
      outcome: "reproduced",
      reason: "vulnerable_predicate_matched",
      steps,
      evidenceSha256: "e".repeat(64),
    });

  it("saves immutable versions with optimistic concurrency", async () => {
    const tables = seed();
    const ctx = createCtx(tables);
    expect(await save(ctx, 0)).toEqual({ success: true, version: 1 });
    expect(await save(ctx, 0, recipe("usr_other"))).toMatchObject({
      success: false,
      error: "conflict",
      current_version: 1,
    });
    expect(await save(ctx, 1, recipe("usr_other"))).toEqual({
      success: true,
      version: 2,
    });
    expect(tables.finding_retest_recipes.map((r) => r.version)).toEqual([1, 2]);
    expect(
      tables.finding_retest_recipes[0].recipe.probe.vulnerable.json[0].equals,
    ).toBe("usr_victim_a");
  });

  it("rejects a recipe that would treat 401 as fixed", async () => {
    const ctx = createCtx(seed());
    const bad = recipe();
    (bad.probe.not_reproduced as any).statuses = [401];
    expect(await save(ctx, 0, bad)).toMatchObject({
      success: false,
      error: "validation",
    });
  });

  it("refuses cross-origin recipes and fences an edited target or computer at claim", async () => {
    const tables = seed();
    const ctx = createCtx(tables);
    expect(
      await save(ctx, 0, { ...recipe(), origin: "https://other.test" }),
    ).toMatchObject({
      success: false,
      error: "validation",
    });
    await save(ctx, 0);
    tables.chats[0].sandbox_type = "e2b";
    expect(await start(ctx, "changed-computer")).toMatchObject({
      success: false,
      error: "conflict",
    });
    tables.chats[0].sandbox_type = "desktop-env";
    tables.findings[0].target = "https://different.test";
    expect(await start(ctx, "changed-target")).toMatchObject({
      success: false,
      error: "conflict",
    });
    expect(tables.finding_retest_runs).toEqual([]);
  });

  it("denies another user's finding, a deleting chat and a deletion-fenced user", async () => {
    const tables = seed();
    const ctx = createCtx(tables);
    expect(
      await (mod.getStateForBackend as any).handler(ctx, {
        ...base,
        findingId: "finding-other",
      }),
    ).toEqual({ available: false });
    expect(
      await (mod.getStateForBackend as any).handler(ctx, {
        ...base,
        chatId: "chat-2",
      }),
    ).toEqual({ available: false });
    tables.chats[0].deletion_started_at = 1;
    expect(await save(ctx, 0)).toMatchObject({ error: "not_found" });
    delete tables.chats[0].deletion_started_at;
    tables.user_deletion_fences.push({ _id: "fence", user_id: "user-1" });
    expect(await start(ctx, "request-0001")).toMatchObject({
      error: "not_found",
    });
  });

  it("starts one run per finding, dedupes retries and fences the version", async () => {
    const tables = seed();
    const ctx = createCtx(tables);
    await save(ctx, 0);
    expect(await start(ctx, "request-0001", 2)).toMatchObject({
      error: "conflict",
    });
    const first = await start(ctx, "request-0001");
    expect(first).toMatchObject({
      success: true,
      duplicate: false,
      sandbox_preference: "desktop-env",
      run: { status: "running", recipe_version: 1 },
    });
    expect(await start(ctx, "request-0001")).toMatchObject({
      success: true,
      duplicate: true,
    });
    expect(await start(ctx, "request-0002")).toMatchObject({ error: "busy" });
    expect(tables.finding_retest_runs).toHaveLength(1);
  });

  it("finalizes once and keeps finished runs immutable", async () => {
    const tables = seed();
    const ctx = createCtx(tables);
    await save(ctx, 0);
    const { run } = await start(ctx, "request-0001");
    expect(await finish(ctx, run.run_id, "wrong-request")).toEqual({
      success: false,
      error: "not_found",
    });
    expect(await finish(ctx, run.run_id, "request-0001")).toMatchObject({
      success: true,
      run: { status: "finished", outcome: "reproduced" },
    });
    const stored = { ...tables.finding_retest_runs[0] };
    const late = await (mod.finishRunForBackend as any).handler(ctx, {
      serviceKey: "k",
      userId: "user-1",
      runId: run.run_id,
      requestId: "request-0001",
      outcome: "not_reproduced",
      reason: "nonreproduction_predicate_matched",
      steps,
      evidenceSha256: "f".repeat(64),
    });
    expect(late).toEqual({ success: false, error: "stale" });
    expect(tables.finding_retest_runs[0]).toEqual(stored);
  });

  it("interrupts an expired lease and fences its late result", async () => {
    const tables = seed();
    const ctx = createCtx(tables);
    await save(ctx, 0);
    const now = Date.now();
    const clock = jest.spyOn(Date, "now").mockReturnValue(now);
    const { run } = await start(ctx, "request-0001");
    clock.mockReturnValue(now + mod.RETEST_RUN_LEASE_MS + 1);
    const state = await (mod.getStateForBackend as any).handler(ctx, base);
    expect(state.runs[0]).toMatchObject({
      status: "finished",
      outcome: "error",
      reason: "interrupted",
    });
    expect(await start(ctx, "request-0002")).toMatchObject({ success: true });
    expect(await finish(ctx, run.run_id, "request-0001")).toEqual({
      success: false,
      error: "stale",
    });
    expect(tables.finding_retest_runs[0]).toMatchObject({
      outcome: "error",
      reason: "interrupted",
    });
  });

  it("rate limits runs per user per hour", async () => {
    const tables = seed();
    const ctx = createCtx(tables);
    await save(ctx, 0);
    for (let i = 0; i < mod.RETEST_RUNS_PER_HOUR; i++)
      tables.finding_retest_runs.push({
        _id: `old-${i}`,
        user_id: "user-1",
        finding_id: "elsewhere",
        status: "finished",
        started_at: Date.now() - 1000,
        request_id: `old-${i}`,
      });
    expect(await start(ctx, "request-0001")).toMatchObject({
      error: "rate_limited",
    });
  });

  it("deletes a chat's retest rows in batches without touching other chats", async () => {
    const tables = seed();
    for (let i = 0; i < 60; i++)
      tables.finding_retest_runs.push({
        _id: `r${i}`,
        user_id: "user-1",
        chat_id: "chat-1",
      });
    tables.finding_retest_recipes.push(
      { _id: "keep", user_id: "user-2", chat_id: "chat-2" },
      { _id: "drop", user_id: "user-1", chat_id: "chat-1" },
    );
    const ctx = createCtx(tables);
    expect(
      await mod.deleteFindingRetestsForChatBatch(ctx, "user-1", "chat-1"),
    ).toBe(true);
    expect(
      await mod.deleteFindingRetestsForChatBatch(ctx, "user-1", "chat-1"),
    ).toBe(false);
    expect(tables.finding_retest_runs).toHaveLength(0);
    expect(tables.finding_retest_recipes.map((r) => r._id)).toEqual(["keep"]);
  });
});
