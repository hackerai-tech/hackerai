import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

// Convex rejects a function that runs more than one paginated query. Every
// registered handler gets its own count, which the fake database enforces.
const mockFunctionRun = { paginated: 0, iterated: 0 };
jest.mock("../lib/serviceFunctions", () => {
  const registered = (config: any) => ({
    ...config,
    handler: async (ctx: unknown, args: unknown) => {
      const outer = mockFunctionRun.paginated;
      mockFunctionRun.paginated = 0;
      try {
        return await config.handler(ctx, args);
      } finally {
        mockFunctionRun.paginated = outer;
      }
    },
  });
  return {
    mutation: registered,
    internalMutation: registered,
    query: registered,
  };
});
jest.mock("convex/values", () => {
  const actual =
    jest.requireActual<typeof import("convex/values")>("convex/values");
  return {
    ...actual,
    v: new Proxy({}, { get: () => jest.fn(() => "validator") }),
  };
});
jest.mock("convex/server", () => ({
  paginationOptsValidator: "paginationOptsValidator",
}));
// Scheduled function references become "module.function" names.
jest.mock("../_generated/api", () => ({
  internal: new Proxy(
    {},
    {
      get: (_target, module) =>
        new Proxy(
          {},
          { get: (_inner, fn) => `${String(module)}.${String(fn)}` },
        ),
    },
  ),
}));
jest.mock("../fileAggregate", () => ({
  fileCountAggregate: {
    deleteIfExists: jest.fn<any>().mockResolvedValue(undefined),
  },
}));
jest.mock("../lib/utils", () => ({ validateServiceKey: jest.fn() }));
jest.mock("../lib/suspensionGuards", () => ({
  assertUserCanAccessChatHistory: jest.fn<any>().mockResolvedValue(undefined),
}));

import { createFindingDedupeKey } from "../../lib/findings/validation";

type Row = { _id: string; _creationTime: number; [key: string]: any };
type Tables = Record<string, Row[]>;
type Test = (row: Row) => boolean;

/**
 * In-memory database with the query surface these functions use. An index
 * range and a later `.filter()` are kept apart so a bounded scan
 * (`maximumRowsRead`) reads rows the filter then discards, as Convex does.
 */
function createDb(tables: Tables) {
  let serial = 0;
  const rowsOf = (table: string) => (tables[table] ??= []);
  const orderKey = (row: Row) =>
    row.created_at ?? row.latest_finding_at ?? row._creationTime;
  const clean = (value: Record<string, any>) =>
    Object.fromEntries(
      Object.entries(value).filter(([, field]) => field !== undefined),
    );

  const read = (table: string, indexed: Test[]) => {
    let direction = 1;
    const post: Test[] = [];
    const range = () =>
      rowsOf(table)
        .filter((row) => indexed.every((test) => test(row)))
        .sort(
          (a, b) =>
            direction *
            (orderKey(a) - orderKey(b) || a._creationTime - b._creationTime),
        );
    const matches = () =>
      range().filter((row) => post.every((test) => test(row)));
    const api: any = {
      order: (next: "asc" | "desc") => {
        direction = next === "desc" ? -1 : 1;
        return api;
      },
      filter: (build: (q: any) => Test) => {
        post.push(
          build({
            field: (name: string) => (row: Row) => row[name],
            eq: (field: (row: Row) => unknown, value: unknown) => (row: Row) =>
              field(row) === value,
          }),
        );
        return api;
      },
      first: async () => matches()[0] ?? null,
      unique: async () => {
        const found = matches();
        if (found.length > 1) throw new Error(`Expected a unique ${table} row`);
        return found[0] ?? null;
      },
      take: async (limit: number) => matches().slice(0, limit),
      collect: async () => matches(),
      paginate: async ({
        cursor,
        numItems,
        maximumRowsRead = Infinity,
      }: {
        cursor: string | null;
        numItems: number;
        maximumRowsRead?: number;
      }) => {
        if (++mockFunctionRun.paginated > 1)
          throw new Error(
            "This query function ran multiple paginated queries. Convex only supports a single paginated query in each query function.",
          );
        const scanned = range();
        let index = cursor ? Number(cursor) : 0;
        const page: Row[] = [];
        for (
          let rowsRead = 0;
          index < scanned.length &&
          page.length < numItems &&
          rowsRead < maximumRowsRead;
          rowsRead++
        ) {
          const row = scanned[index++];
          if (post.every((test) => test(row))) page.push(row);
        }
        return {
          page,
          isDone: index >= scanned.length,
          continueCursor: String(index),
        };
      },
      // Streams one document at a time; a caller that stops early reads no more.
      async *[Symbol.asyncIterator]() {
        for (const row of matches()) {
          mockFunctionRun.iterated++;
          yield row;
        }
      },
    };
    return api;
  };

  const equalities = (build: (q: any) => unknown, extra: Test[] = []) => {
    const tests = [...extra];
    const q: any = {
      eq: (field: string, value: unknown) => {
        tests.push((row) => row[field] === value);
        return q;
      },
      search: (field: string, text: string) => {
        tests.push((row) =>
          String(row[field] ?? "")
            .toLowerCase()
            .includes(text.toLowerCase()),
        );
        return q;
      },
    };
    build(q);
    return tests;
  };

  return {
    query: (table: string) => ({
      ...read(table, []),
      withIndex: (_name: string, build: (q: any) => unknown) =>
        read(table, equalities(build)),
      withSearchIndex: (_name: string, build: (q: any) => unknown) =>
        read(table, equalities(build)),
    }),
    get: async (id: string) =>
      Object.values(tables)
        .flat()
        .find((row) => row._id === id) ?? null,
    insert: async (table: string, value: Record<string, any>) => {
      const _id = `${table}:${++serial}`;
      rowsOf(table).push({ _id, _creationTime: serial, ...clean(value) });
      return _id;
    },
    patch: async (id: string, value: Record<string, any>) => {
      const row = Object.values(tables)
        .flat()
        .find((candidate) => candidate._id === id);
      if (!row) throw new Error(`Missing row ${id}`);
      for (const [key, field] of Object.entries(value))
        if (field === undefined) delete row[key];
        else row[key] = field;
    },
    delete: async (id: string) => {
      for (const table of Object.keys(tables))
        tables[table] = tables[table].filter((row) => row._id !== id);
    },
    normalizeId: (table: string, id: string) =>
      typeof id === "string" && id.startsWith(`${table}:`) ? id : null,
  };
}

const report = (overrides: Record<string, unknown> = {}) => ({
  title: "Cross-tenant invoice access",
  description: "An authenticated user can read another user's invoice.",
  impact: "A user can disclose another customer's billing address.",
  target: "https://app.example.test",
  endpoint: "/api/invoices/:id",
  method: "get",
  cwe: "CWE-639",
  technical_analysis: "The handler loads by id without an owner check.",
  poc_description: "Request user B's invoice while signed in as user A.",
  poc_script_code: "curl -H 'Authorization: Bearer user-a' /api/invoices/b",
  remediation_steps: "Scope the invoice query to the authenticated user.",
  evidence: "The response returned user B's billing address.",
  assumptions: "Both accounts are ordinary customer accounts.",
  confidence: "high",
  counterevidence: "An owner check was absent on the tested path.",
  severity_change_conditions:
    "A verified owner check would rule out this path.",
  fix_effort: "low",
  cvss_breakdown: {
    attack_vector: "N",
    attack_complexity: "L",
    privileges_required: "L",
    user_interaction: "N",
    scope: "U",
    confidentiality: "H",
    integrity: "N",
    availability: "N",
  },
  ...overrides,
});

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const SCOPE = "a".repeat(64);
const OTHER_SCOPE = "b".repeat(64);
const SCHEDULE_NAME = "Nightly API scan";
type Task = { chatId: string; userId: string; runId?: string };

let now: number;
let clock: ReturnType<typeof jest.spyOn>;
beforeEach(() => {
  jest.clearAllMocks();
  now = Date.UTC(2026, 10, 1);
  clock = jest.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(() => clock.mockRestore());

async function world() {
  const findings = await import("../findings");
  const tables: Tables = {};
  const db = createDb(tables);
  const queue: Array<{ ref: string; args: any }> = [];
  const scheduler = {
    runAfter: jest.fn(async (_delay: number, ref: string, args: any) => {
      queue.push({ ref, args });
    }),
  };
  const as = (subject: string | null) =>
    ({
      db,
      scheduler,
      auth: {
        getUserIdentity: async () => (subject ? { subject } : null),
      },
    }) as any;
  const ctx = as("user-1");
  let tasks = 0;
  let calls = 0;

  const schedule = (userId = "user-1", name = SCHEDULE_NAME) =>
    db.insert("agent_schedules", { user_id: userId, definition: { name } });
  const scheduledTask = async (
    scheduleId: string,
    {
      userId = "user-1",
      scopeKey = SCOPE,
      projectId,
    }: { userId?: string; scopeKey?: string; projectId?: string } = {},
  ): Promise<Task> => {
    const chatId = `task-${++tasks}`;
    const runId = await db.insert("schedule_runs", {
      schedule_id: scheduleId,
      user_id: userId,
      chat_id: chatId,
    });
    await db.insert("chats", {
      id: chatId,
      user_id: userId,
      title: `Run ${tasks}`,
      update_time: 1,
      project_id: projectId,
      schedule_origin: {
        scheduleId,
        scheduleName: SCHEDULE_NAME,
        runId,
        scopeKey,
      },
    });
    return { chatId, userId, runId };
  };
  const ordinaryTask = async (userId = "user-1"): Promise<Task> => {
    const chatId = `task-${++tasks}`;
    await db.insert("chats", {
      id: chatId,
      user_id: userId,
      title: `Chat ${tasks}`,
      update_time: 1,
    });
    return { chatId, userId };
  };
  const scope = (task: Task) => ({
    serviceKey: "service",
    userId: task.userId,
    chatId: task.chatId,
  });
  const save = (task: Task, overrides: Record<string, unknown> = {}) => {
    now += 60_000;
    return findings.createFindingForBackend.handler(ctx, {
      ...scope(task),
      messageId: `${task.chatId}-message`,
      toolCallId: `call-${++calls}`,
      report: report(),
      ...overrides,
    } as any) as Promise<any>;
  };
  /** Saves the first report of a schedule and returns its public ID. */
  const saveFirst = async (
    task: Task,
    overrides: Record<string, unknown> = {},
  ) => {
    const result = await save(task, overrides);
    if (!result.success) throw new Error(`Expected a saved finding`);
    return result.finding_id as string;
  };
  const correct = (
    task: Task,
    findingId: string,
    changes: Record<string, unknown>,
    expectedUpdatedAt = saved(findingId).updated_at,
  ) => {
    now += 60_000;
    return findings.updateFindingForBackend.handler(ctx, {
      ...scope(task),
      messageId: `${task.chatId}-correction`,
      toolCallId: `call-${++calls}`,
      update: {
        finding_id: findingId,
        expected_updated_at: expectedUpdatedAt,
        reason: "New evidence from this run",
        changes,
      },
    } as any) as Promise<any>;
  };
  const saved = (findingId: string) =>
    (tables.findings ?? []).find((row) => row.finding_id === findingId)!;
  const runRecords = (findingId?: string) =>
    (tables.schedule_finding_observations ?? []).filter(
      (row) => findingId === undefined || row.finding_id === findingId,
    );
  /** Runs queued cleanup callbacks until none remain. */
  const drain = async (
    handlers: Record<string, { handler: (ctx: any, args: any) => unknown }>,
  ) => {
    let runs = 0;
    while (queue.length) {
      const job = queue.shift()!;
      if (!handlers[job.ref]) continue;
      if (++runs > 60) throw new Error("Cleanup did not finish");
      await handlers[job.ref].handler(ctx, job.args);
    }
    return runs;
  };

  return {
    findings,
    tables,
    db,
    ctx,
    as,
    queue,
    schedule,
    scheduledTask,
    ordinaryTask,
    scope,
    save,
    saveFirst,
    correct,
    saved,
    runRecords,
    drain,
  };
}

/** Deletes a task through the real deletion path and its batch callbacks. */
const deleteTask = async (w: any, task: Task) => {
  const chats = await import("../chats");
  await (chats.deleteChatForBackend as any).handler(w.ctx, {
    serviceKey: "service",
    chatId: task.chatId,
    userId: task.userId,
    expectedTriggerRunId: null,
    expectedApprovalSessionId: null,
  });
  return w.drain({
    "chats.deleteChatForBackendBatch": chats.deleteChatForBackendBatch,
  });
};

describe("findings repeated across runs of one schedule", () => {
  it("reports new and repeated findings separately in a completed run", async () => {
    const w = await world();
    const { list } = await import("../schedules");
    const scheduleId = await w.schedule();
    const first = await w.scheduledTask(scheduleId);
    const latest = await w.scheduledTask(scheduleId);
    await w.saveFirst(first);
    await w.save(latest);
    await w.save(latest);
    await w.saveFirst(latest, {
      report: report({
        title: "Synthetic fixture missing a review label",
        endpoint: "/fixture-review-label",
      }),
    });
    await w.db.patch(latest.runId!, { status: "finished" });

    const listForOwner = () =>
      (list as any).handler(w.ctx, { serviceKey: "service", userId: "user-1" });
    expect((await listForOwner())[0].runs[0]).toMatchObject({
      chatId: latest.chatId,
      findingSummary: { newCount: 1, repeatCount: 1 },
    });

    const newerObservation = w
      .runRecords()
      .find((r) => r.run_id === latest.runId)!;
    await w.db.patch(newerObservation._id, { first_report: undefined });
    expect((await listForOwner())[0].runs[0]).not.toHaveProperty(
      "findingSummary",
    );
  });

  it("keeps one saved finding and counts each reporting run once", async () => {
    const w = await world();
    const scheduleId = await w.schedule();
    const first = await w.scheduledTask(scheduleId);
    const second = await w.scheduledTask(scheduleId);
    const findingId = await w.saveFirst(first);
    const original = clone(w.saved(findingId));
    expect(original).toMatchObject({
      schedule_id: scheduleId,
      schedule_name: SCHEDULE_NAME,
      schedule_scope_key: SCOPE,
      schedule_observation_count: 1,
      schedule_observations: [
        {
          run_id: first.runId,
          chat_id: first.chatId,
          message_id: `${first.chatId}-message`,
        },
      ],
    });

    const repeat = await w.save(second, {
      report: report({
        title: "  CROSS-TENANT   invoice access ",
        evidence: "A different capture from the second run.",
      }),
    });
    expect(repeat).toMatchObject({
      success: false,
      error: "duplicate",
      duplicate_of: findingId,
      message: expect.stringContaining("earlier run of this schedule"),
    });
    // A tool retry, a repeat in a later message, and the source run repeating.
    await w.save(second);
    await w.save(second, { messageId: "a-later-message" });
    expect(await w.save(first)).toMatchObject({
      error: "duplicate",
      message: expect.stringContaining("in this chat"),
    });

    expect(w.tables.findings).toHaveLength(1);
    const row = w.saved(findingId);
    expect(row).toMatchObject({
      chat_id: first.chatId,
      message_id: `${first.chatId}-message`,
      tool_call_id: original.tool_call_id,
      evidence: original.evidence,
      title: original.title,
      status: "active",
      updated_at: original.updated_at,
      schedule_observation_count: 2,
    });
    expect(row.schedule_observations).toEqual([
      original.schedule_observations[0],
      {
        run_id: second.runId,
        chat_id: second.chatId,
        message_id: `${second.chatId}-message`,
        observed_at: expect.any(Number),
      },
    ]);
    expect(w.runRecords(findingId).map((record) => record.run_id)).toEqual([
      first.runId,
      second.runId,
    ]);
    expect(w.tables.finding_sources).toEqual([
      expect.objectContaining({
        chat_id: first.chatId,
        finding_count: 1,
        schedule_id: scheduleId,
      }),
    ]);
  });

  it("counts a late first report after more than twenty newer runs, and never a repeat of an evicted run", async () => {
    const w = await world();
    const scheduleId = await w.schedule();
    const source = await w.scheduledTask(scheduleId);
    // Started early, but reports only after many newer runs have.
    const late = await w.scheduledTask(scheduleId);
    const findingId = await w.saveFirst(source);
    const newer: Task[] = [];
    for (let n = 0; n < 22; n++) {
      newer.push(await w.scheduledTask(scheduleId));
      await w.save(newer[n]);
    }
    const row = () => w.saved(findingId);
    const retained = () =>
      row().schedule_observations.map((entry: any) => entry.chat_id);
    expect(row().schedule_observation_count).toBe(23);
    expect(retained()).toEqual(newer.slice(2).map((task) => task.chatId));

    // Both evicted runs repeat: the source run and the oldest later run.
    await w.save(source);
    await w.save(newer[0]);
    await w.save(newer[1], { messageId: "a-later-message" });
    expect(row().schedule_observation_count).toBe(23);
    expect(retained()).toEqual(newer.slice(2).map((task) => task.chatId));

    expect(await w.save(late)).toMatchObject({
      error: "duplicate",
      duplicate_of: findingId,
    });
    expect(row().schedule_observation_count).toBe(24);
    expect(retained()).toEqual([
      ...newer.slice(3).map((task) => task.chatId),
      late.chatId,
    ]);
    await w.save(late);
    expect(row().schedule_observation_count).toBe(24);
    expect(row().schedule_observations).toHaveLength(20);
    expect(w.runRecords(findingId)).toHaveLength(24);
    expect(w.tables.findings).toHaveLength(1);
  });

  it("records a reworded duplicate from a later run and keeps the comparison fence", async () => {
    const w = await world();
    const scheduleId = await w.schedule();
    const first = await w.scheduledTask(scheduleId);
    const second = await w.scheduledTask(scheduleId);
    const third = await w.scheduledTask(scheduleId);
    const findingId = await w.saveFirst(first);
    const reworded = report({
      title: "Billing documents readable across accounts",
    });
    const context = (task: Task, body = reworded) =>
      w.findings.getFindingDedupeContextForBackend.handler(w.ctx, {
        ...w.scope(task),
        dedupeKey: createFindingDedupeKey(body as any),
      });

    expect((await context(second, report())).exact_duplicate_id).toBe(
      findingId,
    );
    const compared = await context(second);
    expect(compared).toEqual({
      exact_duplicate_id: null,
      candidates: [
        expect.objectContaining({
          finding_id: findingId,
          updated_at: w.saved(findingId).updated_at,
        }),
      ],
    });
    const snapshot = compared.candidates.map(({ finding_id, updated_at }) => ({
      finding_id,
      updated_at,
    }));

    // A decision made against a stale view is rejected and records nothing.
    expect(
      await w.save(second, {
        report: reworded,
        comparisonSnapshot: [],
        semanticDuplicateId: findingId,
      }),
    ).toEqual({ success: false, error: "comparison_stale" });
    expect(w.saved(findingId).schedule_observation_count).toBe(1);

    expect(
      await w.save(second, {
        report: reworded,
        comparisonSnapshot: snapshot,
        semanticDuplicateId: findingId,
      }),
    ).toMatchObject({
      error: "duplicate",
      duplicate_of: findingId,
      message: expect.stringContaining("earlier run of this schedule"),
    });
    // Recording a run does not change the report's revision, so a comparison
    // made by another run at the same time is still valid.
    expect(
      await w.save(third, {
        report: reworded,
        comparisonSnapshot: snapshot,
        semanticDuplicateId: findingId,
      }),
    ).toMatchObject({ error: "duplicate", duplicate_of: findingId });
    expect(w.saved(findingId)).toMatchObject({
      schedule_observation_count: 3,
      title: "Cross-tenant invoice access",
    });

    // A distinct report against the same view is saved as its own finding.
    expect(
      await w.save(third, {
        report: report({ title: "Invoice deletion without ownership check" }),
        comparisonSnapshot: snapshot,
      }),
    ).toMatchObject({ success: true });
    expect(w.tables.findings).toHaveLength(2);
  });

  it("does not reopen or rewrite a closed finding when a later run reports it", async () => {
    const w = await world();
    const scheduleId = await w.schedule();
    const first = await w.scheduledTask(scheduleId);
    const second = await w.scheduledTask(scheduleId);
    const findingId = await w.saveFirst(first);
    await w.findings.closeFinding.handler(w.ctx, {
      findingId,
      reason: "wont_fix",
      context: "Accepted for the legacy tenant.",
    });
    const closed = clone(w.saved(findingId));

    expect(
      await w.save(second, {
        report: report({ evidence: "Reproduced again in the second run." }),
      }),
    ).toMatchObject({ error: "duplicate", duplicate_of: findingId });

    expect(w.saved(findingId)).toEqual({
      ...closed,
      schedule_observation_count: 2,
      schedule_observations: [
        closed.schedule_observations[0],
        expect.objectContaining({ chat_id: second.chatId }),
      ],
    });
    expect(w.tables.findings).toHaveLength(1);
  });
});

describe("schedule finding boundaries", () => {
  it.each<[string, (w: any, scheduleId: string) => Promise<Task>]>([
    [
      "another account naming the same schedule",
      (w, scheduleId) => w.scheduledTask(scheduleId, { userId: "user-2" }),
    ],
    [
      "another schedule",
      async (w) => w.scheduledTask(await w.schedule("user-1", "Other")),
    ],
    [
      "changed instructions",
      (w, scheduleId) => w.scheduledTask(scheduleId, { scopeKey: OTHER_SCOPE }),
    ],
    [
      "another project",
      (w, scheduleId) =>
        w.scheduledTask(scheduleId, { projectId: "project-2" }),
    ],
    ["an ordinary task", (w) => w.ordinaryTask()],
  ])(
    "does not share, read or change a finding from %s",
    async (_label, outside) => {
      const w = await world();
      const scheduleId = await w.schedule();
      const findingId = await w.saveFirst(await w.scheduledTask(scheduleId));
      const before = JSON.stringify(w.saved(findingId));
      const task = await outside(w, scheduleId);

      expect(
        await w.findings.getFindingDedupeContextForBackend.handler(w.ctx, {
          ...w.scope(task),
          dedupeKey: createFindingDedupeKey(report() as any),
        }),
      ).toEqual({ exact_duplicate_id: null, candidates: [] });
      expect(
        await w.findings.getReportForBackend.handler(w.ctx, {
          ...w.scope(task),
          findingId,
        }),
      ).toMatchObject({ success: false, error: "not_found" });
      expect(
        await w.correct(task, findingId, { impact: "Changed from outside." }),
      ).toMatchObject({ success: false, error: "not_found" });
      // A forged comparison cannot attach this run to the finding either.
      expect(
        await w.save(task, {
          comparisonSnapshot: [],
          semanticDuplicateId: findingId,
        }),
      ).toMatchObject({ success: false, error: "validation" });

      expect(await w.save(task)).toMatchObject({ success: true });
      expect(w.tables.findings).toHaveLength(2);
      expect(JSON.stringify(w.saved(findingId))).toBe(before);
      expect(w.runRecords(findingId)).toHaveLength(1);
    },
  );

  it.each([
    ["is being deleted", { deletion_started_at: 1 }],
    ["moved to a project", { project_id: "project-9" }],
    ["changed owner", { user_id: "user-2" }],
  ])(
    "stops sharing a finding once its source task %s",
    async (_label, change) => {
      const w = await world();
      const scheduleId = await w.schedule();
      const source = await w.scheduledTask(scheduleId);
      const later = await w.scheduledTask(scheduleId);
      const findingId = await w.saveFirst(source);
      const before = JSON.stringify(w.saved(findingId));
      Object.assign(
        w.tables.chats.find((chat) => chat.id === source.chatId)!,
        change,
      );

      expect(
        await w.findings.getReportForBackend.handler(w.ctx, {
          ...w.scope(later),
          findingId,
        }),
      ).toMatchObject({ success: false, error: "not_found" });
      const replacement = await w.save(later);
      expect(replacement).toMatchObject({ success: true });
      expect(replacement.finding_id).not.toBe(findingId);
      expect(JSON.stringify(w.saved(findingId))).toBe(before);
    },
  );

  it("is not blocked or hidden by the same finding saved in many other projects", async () => {
    const w = await world();
    const scheduleId = await w.schedule();
    // More copies than the bounded lookup reads, each in its own project.
    for (let n = 0; n < 30; n++)
      await w.saveFirst(
        await w.scheduledTask(scheduleId, { projectId: `project-${n}` }),
      );
    const first = await w.scheduledTask(scheduleId);
    const later = await w.scheduledTask(scheduleId);

    const findingId = await w.saveFirst(first);
    expect(
      await w.findings.getFindingDedupeContextForBackend.handler(w.ctx, {
        ...w.scope(later),
        dedupeKey: createFindingDedupeKey(report() as any),
      }),
    ).toEqual({
      exact_duplicate_id: findingId,
      candidates: [expect.objectContaining({ finding_id: findingId })],
    });
    expect(await w.save(later)).toMatchObject({
      error: "duplicate",
      duplicate_of: findingId,
    });
    expect(w.tables.findings).toHaveLength(31);
    expect(w.saved(findingId).schedule_observation_count).toBe(2);
  });

  it("refuses to save a second copy while unavailable copies fill the lookup, then resolves to the saved finding", async () => {
    const w = await world();
    const scheduleId = await w.schedule();
    // Twelve tasks saved the same finding in separate projects and were then
    // moved into one project. The first eleven are now being deleted.
    const sources: Task[] = [];
    const ids: string[] = [];
    for (let n = 0; n < 12; n++) {
      sources.push(
        await w.scheduledTask(scheduleId, { projectId: `project-${n}` }),
      );
      ids.push(await w.saveFirst(sources[n]));
    }
    for (const row of [...w.tables.chats, ...w.tables.findings])
      row.project_id = "project-shared";
    for (const task of sources.slice(0, 11))
      w.tables.chats.find(
        (chat) => chat.id === task.chatId,
      )!.deletion_started_at = 1;
    const canonical = ids[11];
    const later = await w.scheduledTask(scheduleId, {
      projectId: "project-shared",
    });
    const before = JSON.stringify(w.tables.findings);

    const blocked = await w.save(later);
    expect(blocked).toEqual({
      success: false,
      error: "temporarily_unavailable",
      retryable: true,
      message: expect.stringContaining("Retry the same report"),
    });
    // The same holds when the model compared against the visible candidates.
    expect(
      await w.save(later, {
        comparisonSnapshot: [
          {
            finding_id: canonical,
            updated_at: w.saved(canonical).updated_at,
          },
        ],
      }),
    ).toMatchObject({ error: "temporarily_unavailable" });
    // A correction that would take the same key is held back as well.
    const otherId = await w.saveFirst(later, {
      report: report({ title: "Unrelated finding" }),
    });
    expect(
      await w.correct(later, otherId, {
        title: "Cross-tenant invoice access",
      }),
    ).toMatchObject({ success: false, error: "temporarily_unavailable" });
    expect(w.saved(otherId).title).toBe("Unrelated finding");
    expect(
      JSON.stringify(
        w.tables.findings.filter((row) => row.finding_id !== otherId),
      ),
    ).toBe(before);
    expect(w.runRecords(canonical)).toHaveLength(1);

    for (const task of sources.slice(0, 11)) await deleteTask(w, task);
    expect(w.tables.findings.map((row) => row.finding_id)).toEqual([
      canonical,
      otherId,
    ]);

    expect(await w.save(later)).toMatchObject({
      success: false,
      error: "duplicate",
      duplicate_of: canonical,
    });
    expect(w.saved(canonical).schedule_observation_count).toBe(2);
    expect(w.tables.findings).toHaveLength(2);
  });

  it("bounds shared-finding reads by rows and by bytes", async () => {
    const w = await world();
    const scheduleId = await w.schedule();
    const source = await w.scheduledTask(scheduleId);
    const gone = await w.scheduledTask(scheduleId);
    const later = await w.scheduledTask(scheduleId);
    w.tables.chats.find(
      (chat) => chat.id === gone.chatId,
    )!.deletion_started_at = 1;
    const seed = (n: number, extra: Record<string, unknown> = {}) =>
      w.db.insert("findings", {
        finding_id: `seed-${n}`,
        user_id: "user-1",
        chat_id: source.chatId,
        title: `Seeded ${n}`,
        target: "app.example.test",
        description: "Seeded description.",
        technical_analysis: "Seeded analysis.",
        dedupe_key: `key-${n}`,
        schedule_id: scheduleId,
        schedule_scope_key: SCOPE,
        created_at: n,
        updated_at: n,
        ...extra,
      });
    const candidates = async () => {
      mockFunctionRun.iterated = 0;
      const context =
        await w.findings.getFindingDedupeContextForBackend.handler(w.ctx, {
          ...w.scope(later),
          dedupeKey: "absent",
        });
      return context.candidates.map((candidate) => candidate.finding_id);
    };
    const seeds = (from: number, to: number) =>
      Array.from({ length: from - to + 1 }, (_, n) => `seed-${from - n}`);

    for (let n = 0; n < 40; n++) await seed(n);
    expect(await candidates()).toEqual(seeds(39, 15));
    expect(mockFunctionRun.iterated).toBe(25);

    // Large reports reach the byte budget before the row limit.
    for (let n = 40; n < 50; n++)
      await seed(n, { evidence: "x".repeat(300_000) });
    expect(await candidates()).toEqual(seeds(49, 43));
    expect(mockFunctionRun.iterated).toBe(7);

    // The exact lookup stops the same way, and treats what it could not read
    // as unknown instead of saving another copy.
    for (let n = 50; n < 58; n++)
      await seed(n, {
        chat_id: gone.chatId,
        dedupe_key: createFindingDedupeKey(report() as any),
        evidence: "x".repeat(300_000),
      });
    mockFunctionRun.iterated = 0;
    expect(await w.save(later)).toMatchObject({
      success: false,
      error: "temporarily_unavailable",
    });
    expect(mockFunctionRun.iterated).toBe(7);
    expect(w.tables.findings).toHaveLength(58);
  });

  it("lets a later run read and correct the saved finding, naming its own task", async () => {
    const w = await world();
    const scheduleId = await w.schedule();
    const first = await w.scheduledTask(scheduleId);
    const later = await w.scheduledTask(scheduleId);
    const findingId = await w.saveFirst(first);
    const otherId = await w.saveFirst(first, {
      report: report({ title: "Invoice deletion without ownership check" }),
    });
    await w.save(later);
    const original = clone(w.saved(findingId));

    const current = await w.findings.getReportForBackend.handler(w.ctx, {
      ...w.scope(later),
      findingId,
    });
    expect(current).toMatchObject({
      success: true,
      report: {
        finding_id: findingId,
        chat_id: first.chatId,
        chat_title: "Run 1",
        updated_at: original.updated_at,
      },
    });

    expect(
      await w.correct(
        later,
        findingId,
        { impact: "Stale write." },
        original.updated_at - 1,
      ),
    ).toMatchObject({ success: false, error: "conflict" });
    expect(
      await w.correct(later, findingId, {
        title: "Invoice deletion without ownership check",
      }),
    ).toMatchObject({ success: false, error: "duplicate" });
    expect(
      await w.correct(later, findingId, { nonexistent_field: "x" }),
    ).toMatchObject({ success: false, error: "validation" });
    expect(w.saved(findingId)).toEqual(original);

    const corrected = await w.correct(later, findingId, {
      impact: "The second run also disclosed payment references.",
    });
    expect(corrected).toMatchObject({ success: true, finding_id: findingId });
    const row = w.saved(findingId);
    expect(row).toMatchObject({
      impact: "The second run also disclosed payment references.",
      // The original source and its links are unchanged.
      chat_id: first.chatId,
      message_id: `${first.chatId}-message`,
      tool_call_id: original.tool_call_id,
      schedule_observation_count: 2,
      correction_history: [
        {
          chat_id: later.chatId,
          message_id: `${later.chatId}-correction`,
          changed_fields: ["impact"],
        },
      ],
      last_update: { chat_id: later.chatId },
    });
    expect(row.updated_at).toBeGreaterThan(original.updated_at);

    // The source run's own correction keeps the existing shape.
    await w.correct(first, findingId, { impact: "Corrected by the source." });
    expect(w.saved(findingId).correction_history[1]).not.toHaveProperty(
      "chat_id",
    );
    expect(w.saved(findingId).last_update).not.toHaveProperty("chat_id");
    expect(w.saved(otherId).correction_history).toBeUndefined();
  });
});

describe("schedule provenance for the owner", () => {
  const detail = (w: any, findingId: string, subject = "user-1") =>
    w.findings.getFinding.handler(w.as(subject), { findingId });
  const list = (w: any, args: Record<string, unknown>, subject = "user-1") =>
    w.findings.listFindings.handler(w.as(subject), {
      paginationOpts: { cursor: null, numItems: 25 },
      ...args,
    });

  it("stays readable after the schedule is deleted, without a live schedule or deleted tasks", async () => {
    const w = await world();
    const { remove } = await import("../schedules");
    const scheduleId = await w.schedule();
    const first = await w.scheduledTask(scheduleId);
    const second = await w.scheduledTask(scheduleId);
    const findingId = await w.saveFirst(first);
    await w.save(second);
    await w.correct(second, findingId, { impact: "Confirmed by run two." });

    expect(await detail(w, findingId)).toMatchObject({
      schedule: { id: scheduleId, name: SCHEDULE_NAME },
      scheduleAvailable: true,
      observationCount: 2,
      scheduledObservations: [
        {
          chatId: second.chatId,
          messageId: `${second.chatId}-message`,
          taskAvailable: true,
        },
        {
          chatId: first.chatId,
          messageId: `${first.chatId}-message`,
          taskAvailable: true,
        },
      ],
      correction_history: [{ chat_id: second.chatId }],
    });

    await (remove as any).handler(w.ctx, {
      serviceKey: "service",
      userId: "user-1",
      id: scheduleId,
    });
    expect(w.tables.agent_schedules).toHaveLength(0);
    expect(w.tables.schedule_runs).toHaveLength(0);
    // The task whose run reported it second is now being deleted.
    w.tables.chats.find(
      (chat) => chat.id === second.chatId,
    )!.deletion_started_at = 1;

    const retained = await detail(w, findingId);
    expect(retained).toMatchObject({
      schedule: { id: scheduleId, name: SCHEDULE_NAME },
      scheduleAvailable: false,
      observationCount: 2,
    });
    expect(retained.scheduledObservations).toEqual([
      { observedAt: expect.any(Number), taskAvailable: false },
      {
        observedAt: expect.any(Number),
        taskAvailable: true,
        chatId: first.chatId,
        messageId: `${first.chatId}-message`,
      },
    ]);
    expect(retained.correction_history[0]).toMatchObject({
      task_available: false,
    });
    expect(retained.correction_history[0]).not.toHaveProperty("chat_id");

    expect((await list(w, { scheduleId })).page).toEqual([
      expect.objectContaining({
        finding_id: findingId,
        schedule: { id: scheduleId, name: SCHEDULE_NAME },
      }),
    ]);
    // Another account sees nothing, even with the real schedule ID.
    expect(await detail(w, findingId, "user-2")).toBeNull();
    expect((await list(w, { scheduleId }, "user-2")).page).toEqual([]);
    expect(await list(w, { scheduleId: "not-a-schedule-id" })).toEqual({
      page: [],
      isDone: true,
      continueCursor: "",
    });
  });

  it("lists one schedule's findings newest first with pages, facets and search", async () => {
    const w = await world();
    const scheduleId = await w.schedule();
    const otherSchedule = await w.schedule("user-1", "Other");
    const run = await w.scheduledTask(scheduleId);
    const ids: string[] = [];
    for (const title of ["Alpha", "Bravo", "Charlie", "Delta", "Echo"])
      ids.push(await w.saveFirst(run, { report: report({ title }) }));
    await w.saveFirst(await w.scheduledTask(otherSchedule), {
      report: report({ title: "Alpha from another schedule" }),
    });
    await w.saveFirst(await w.ordinaryTask(), {
      report: report({ title: "Alpha from an ordinary task" }),
    });
    await w.findings.closeFinding.handler(w.ctx, {
      findingId: ids[1],
      reason: "already_fixed",
      context: "Fixed in the last release.",
    });

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const result: any = await list(w, {
        scheduleId,
        paginationOpts: { cursor, numItems: 2 },
      });
      seen.push(...result.page.map((row: any) => row.finding_id));
      if (result.isDone) break;
      cursor = result.continueCursor;
    }
    expect(seen).toEqual([...ids].reverse());

    const only = async (args: Record<string, unknown>) =>
      (await list(w, { scheduleId, ...args })).page.map(
        (row: any) => row.finding_id,
      );
    expect(await only({ status: "closed" })).toEqual([ids[1]]);
    expect(await only({ status: "active", severity: "medium" })).toEqual([
      ids[4],
      ids[3],
      ids[2],
      ids[0],
    ]);
    expect(await only({ severity: "critical" })).toEqual([]);
    expect(
      await only({ chatId: run.chatId, category: "access_control" }),
    ).toEqual([...ids].reverse());
    expect(await only({ search: "Alpha" })).toEqual([ids[0]]);
    // Without the schedule filter the same search spans every source.
    expect((await list(w, { search: "Alpha" })).page).toHaveLength(3);
  });

  it("bounds a faceted scan of a large schedule and still returns every match once", async () => {
    const w = await world();
    const scheduleId = await w.schedule();
    const run = await w.scheduledTask(scheduleId);
    const insert = (n: number, severity: string) =>
      w.db.insert("findings", {
        finding_id: `finding-${n}`,
        user_id: "user-1",
        chat_id: run.chatId,
        title: `Finding ${n}`,
        target: "app.example.test",
        severity,
        cvss_score: 5,
        category: "other",
        status: "active",
        schedule_id: scheduleId,
        created_at: n,
      });
    // The only matches are the oldest and the newest of 451 findings.
    await insert(0, "critical");
    for (let n = 1; n < 450; n++) await insert(n, "low");
    await insert(450, "critical");

    const pages: any[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const result: any = await list(w, {
        scheduleId,
        severity: "critical",
        paginationOpts: { cursor, numItems: 25 },
      });
      pages.push(result);
      if (result.isDone) break;
      cursor = result.continueCursor;
    }
    // The first page stops at its scan bound instead of reading all 451 rows.
    expect(pages[0].isDone).toBe(false);
    expect(pages[0].page.map((row: any) => row.finding_id)).toEqual([
      "finding-450",
    ]);
    expect(pages.length).toBeGreaterThan(2);
    expect(
      pages.flatMap((result) => result.page.map((row: any) => row.finding_id)),
    ).toEqual(["finding-450", "finding-0"]);

    // Without a facet there is nothing to discard, so a page is simply full.
    const plain = await list(w, { scheduleId });
    expect(plain.page).toHaveLength(25);
    expect(plain.isDone).toBe(false);
  });
});

describe("schedule run record cleanup", () => {
  it("removes a deleted finding's run records in bounded batches and no others", async () => {
    const w = await world();
    const scheduleId = await w.schedule();
    const run = await w.scheduledTask(scheduleId);
    const findingId = await w.saveFirst(run);
    const keptId = await w.saveFirst(run, {
      report: report({ title: "Kept finding" }),
    });
    for (let n = 0; n < 249; n++)
      await w.db.insert("schedule_finding_observations", {
        user_id: "user-1",
        finding_id: findingId,
        run_id: `schedule_runs:old-${n}`,
        chat_id: `old-task-${n}`,
        observed_at: n,
      });
    expect(w.runRecords(findingId)).toHaveLength(250);

    await w.findings.deleteFinding.handler(w.ctx, { findingId });
    expect(w.saved(findingId)).toBeUndefined();
    const sizes: number[] = [];
    const cleanup = {
      handler: async (ctx: any, args: any) => {
        const before = w.runRecords(findingId).length;
        await w.findings.deleteScheduleObservationsForFinding.handler(
          ctx,
          args,
        );
        sizes.push(before - w.runRecords(findingId).length);
      },
    };
    await w.drain({ "findings.deleteScheduleObservationsForFinding": cleanup });

    expect(sizes).toEqual([100, 100, 50]);
    expect(w.runRecords(findingId)).toHaveLength(0);
    expect(w.runRecords(keptId)).toHaveLength(1);

    // The callback never removes records of a finding that still exists.
    await w.findings.deleteScheduleObservationsForFinding.handler(w.ctx, {
      findingId: keptId,
    });
    expect(w.runRecords(keptId)).toHaveLength(1);
  });

  it("does not queue run-record cleanup for an ordinary finding", async () => {
    const w = await world();
    const findingId = await w.saveFirst(await w.ordinaryTask());
    expect(w.saved(findingId)).not.toHaveProperty("schedule_id");
    expect(w.runRecords()).toHaveLength(0);
    await w.findings.deleteFinding.handler(w.ctx, { findingId });
    expect(w.queue.map((job) => job.ref)).toEqual([
      "findingRetests.deleteForFinding",
      "findingAgentRetests.deleteForFinding",
      "findingHunts.deleteForFinding",
    ]);
  });

  it("deleting a later run's task keeps the finding and its count but forgets that task", async () => {
    const w = await world();
    const scheduleId = await w.schedule();
    const source = await w.scheduledTask(scheduleId);
    const later = await w.scheduledTask(scheduleId);
    const findingId = await w.saveFirst(source);
    // More findings than one cleanup batch scrubs.
    const more: string[] = [];
    for (let n = 0; n < 12; n++)
      more.push(
        await w.saveFirst(source, { report: report({ title: `Issue ${n}` }) }),
      );
    for (const title of [undefined, ...more.map((_, n) => `Issue ${n}`)])
      await w.save(later, title ? { report: report({ title }) } : {});
    expect(w.runRecords()).toHaveLength(26);

    const batches = await deleteTask(w, later);
    expect(batches).toBeGreaterThan(0);
    expect(w.tables.chats.map((chat) => chat.id)).toEqual([source.chatId]);
    expect(w.tables.findings).toHaveLength(13);
    for (const id of [findingId, ...more]) {
      expect(w.saved(id)).toMatchObject({
        schedule_observation_count: 2,
        schedule_observations: [
          { run_id: source.runId, chat_id: source.chatId },
          { run_id: later.runId, observed_at: expect.any(Number) },
        ],
      });
      expect(w.saved(id).schedule_observations[1]).not.toHaveProperty(
        "chat_id",
      );
      expect(w.saved(id).schedule_observations[1]).not.toHaveProperty(
        "message_id",
      );
    }
    expect(JSON.stringify(w.tables.findings)).not.toContain(later.chatId);
    expect(w.runRecords().map((record) => record.chat_id)).toEqual(
      Array(13).fill(source.chatId),
    );

    const shown = await w.findings.getFinding.handler(w.ctx, { findingId });
    expect(shown.observationCount).toBe(2);
    expect(shown.scheduledObservations[0]).toEqual({
      observedAt: expect.any(Number),
      taskAvailable: false,
    });
  });

  it("deleting the source task removes its findings and every run record of them", async () => {
    const w = await world();
    const scheduleId = await w.schedule();
    const source = await w.scheduledTask(scheduleId);
    const findingId = await w.saveFirst(source);
    const unrelated = await w.saveFirst(
      await w.scheduledTask(scheduleId, { scopeKey: OTHER_SCOPE }),
    );
    const laterTasks: Task[] = [];
    for (let n = 0; n < 3; n++) {
      laterTasks.push(await w.scheduledTask(scheduleId));
      await w.save(laterTasks[n]);
    }
    // Enough records that one batch cannot remove them with the finding.
    for (let n = 0; n < 150; n++)
      await w.db.insert("schedule_finding_observations", {
        user_id: "user-1",
        finding_id: findingId,
        run_id: `schedule_runs:old-${n}`,
        chat_id: `old-task-${n}`,
        observed_at: n,
      });

    const batches = await deleteTask(w, source);
    expect(batches).toBeGreaterThan(0);
    expect(w.saved(findingId)).toBeUndefined();
    expect(w.runRecords(findingId)).toHaveLength(0);
    expect(
      (w.tables.finding_sources ?? []).map((row) => row.chat_id),
    ).not.toContain(source.chatId);
    expect(w.tables.chats.map((chat) => chat.id)).not.toContain(source.chatId);
    // Other tasks and findings of the schedule are untouched.
    expect(w.tables.chats).toHaveLength(4);
    expect(w.saved(unrelated)).toBeDefined();
    expect(w.runRecords(unrelated)).toHaveLength(1);

    // With the source gone, the next run saves the finding afresh.
    const again = await w.save(laterTasks[0]);
    expect(again).toMatchObject({ success: true });
    expect(w.saved(again.finding_id).schedule_observation_count).toBe(1);
  });

  it("removes an account's run records with the account and leaves others", async () => {
    const w = await world();
    const { deleteAllUserDataByService } = await import("../userDeletion");
    const mine = await w.schedule();
    const theirs = await w.schedule("user-2");
    const first = await w.scheduledTask(mine);
    const findingId = await w.saveFirst(first);
    await w.save(await w.scheduledTask(mine));
    const theirFinding = await w.saveFirst(
      await w.scheduledTask(theirs, { userId: "user-2" }),
    );
    expect(w.runRecords(findingId)).toHaveLength(2);

    for (let pass = 0, more = true; more; pass++) {
      if (pass > 20) throw new Error("Account cleanup did not finish");
      more = (
        await (deleteAllUserDataByService as any).handler(w.ctx, {
          serviceKey: "service",
          userId: "user-1",
        })
      ).hasMore;
    }

    expect(w.runRecords(findingId)).toHaveLength(0);
    expect(w.saved(findingId)).toBeUndefined();
    expect(w.runRecords(theirFinding)).toHaveLength(1);
    expect(w.saved(theirFinding)).toBeDefined();
  });
});
