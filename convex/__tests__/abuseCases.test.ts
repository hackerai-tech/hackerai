jest.mock("../lib/serviceFunctions", () => ({
  mutation: (config: unknown) => config,
  query: (config: unknown) => config,
}));
jest.mock("../lib/utils", () => ({
  validateServiceKey: (key: string) => {
    if (key !== "test-service") throw new Error("Unauthorized");
  },
}));
import * as functions from "../abuseCases";
import {
  abuseFingerprints,
  encryptAbuseEvidence,
} from "../../lib/abuse/evidence";
jest.mock("server-only", () => ({}));

// Indexed in-memory storage exercises the actual mutation handlers and durable
// state transitions. Live Convex acceptance separately proves transaction semantics.
function database() {
  const tables: Record<string, any[]> = {};
  let sequence = 0;
  const db = {
    query(table: string) {
      tables[table] ??= [];
      let predicates: Array<(row: any) => boolean> = [];
      let descending = false;
      const results = () =>
        tables[table]
          .filter((row) => predicates.every((p) => p(row)))
          .sort((a, b) =>
            descending
              ? b._creationTime - a._creationTime
              : a._creationTime - b._creationTime,
          );
      const chain = {
        withIndex(_index: string, callback: (query: any) => unknown) {
          const query = {
            eq(field: string, value: unknown) {
              predicates.push((row) => row[field] === value);
              return query;
            },
            lt(field: string, value: any) {
              predicates.push((row) => row[field] < value);
              return query;
            },
          };
          callback(query);
          return chain;
        },
        order(value: string) {
          descending = value === "desc";
          return chain;
        },
        async first() {
          return results()[0] ?? null;
        },
        async unique() {
          const rows = results();
          if (rows.length > 1) throw new Error("Duplicate");
          return rows[0] ?? null;
        },
        async take(n: number) {
          return results().slice(0, n);
        },
        async paginate({
          cursor,
          numItems,
        }: {
          cursor: string | null;
          numItems: number;
        }) {
          const offset = Number(cursor ?? 0);
          const rows = results();
          return {
            page: rows.slice(offset, offset + numItems),
            isDone: offset + numItems >= rows.length,
            continueCursor: String(offset + numItems),
            splitCursor: null,
            pageStatus: null,
          };
        },
      };
      return chain;
    },
    async insert(table: string, row: any) {
      const id = `${table}-${++sequence}`;
      (tables[table] ??= []).push({ ...row, _id: id, _creationTime: sequence });
      return id;
    },
    async get(id: string) {
      return (
        Object.values(tables)
          .flat()
          .find((row) => row._id === id) ?? null
      );
    },
    async patch(id: string, patch: any) {
      const row = await db.get(id);
      if (!row) throw new Error("missing");
      Object.assign(row, patch);
    },
    async delete(id: string) {
      for (const rows of Object.values(tables)) {
        const index = rows.findIndex((row) => row._id === id);
        if (index >= 0) rows.splice(index, 1);
      }
    },
  };
  return { db, tables };
}
const invoke = (name: keyof typeof functions, ctx: any, args: any) =>
  (functions[name] as any).handler(ctx, args);
const reference = "AB-123e4567-e89b-42d3-a456-426614174000";
const operator = { serviceKey: "test-service", actor: "operator", reference };
const ciphertext = "v1.test.nonce.tag.encrypted";
const intake = {
  serviceKey: "test-service",
  reference,
  digests: ["1".repeat(64)],
  sourceHashes: ["2".repeat(64)],
  emailHashes: ["3".repeat(64)],
  kind: "abuse",
  ciphertext,
};
const originalEnv = { ...process.env };
beforeEach(() => {
  process.env.ABUSE_OPERATOR_USER_IDS = "operator";
  process.env.ABUSE_INTAKE_ENABLED = "true";
});
afterEach(() => {
  process.env = { ...originalEnv };
});
async function caseWithReview(ctx: any) {
  await invoke("receive", ctx, intake);
  await ctx.db.insert("chats", {
    id: "chat",
    user_id: "subject",
    active_trigger_run_id: "run_root",
  });
  await invoke("annotate", ctx, {
    ...operator,
    expectedRevision: 0,
    kind: "verified_fact",
    ciphertext,
  });
}
test("receipts survive key rotation; changed retries conflict and do not duplicate evidence", async () => {
  const ctx = database();
  const report = { private: "synthetic" };
  process.env.ABUSE_EVIDENCE_KEYS = JSON.stringify({
    active: "old",
    keys: { old: "11".repeat(32) },
  });
  const digests = abuseFingerprints("submission", JSON.stringify(report));
  await invoke("receive", ctx, {
    ...intake,
    digests,
    ciphertext: encryptAbuseEvidence(reference, report),
  });
  process.env.ABUSE_EVIDENCE_KEYS = JSON.stringify({
    active: "new",
    keys: { old: "11".repeat(32), new: "22".repeat(32) },
  });
  expect(
    await invoke("receive", ctx, {
      ...intake,
      digests: abuseFingerprints("submission", JSON.stringify(report)),
    }),
  ).toEqual({ outcome: "received", reference });
  expect(
    await invoke("receive", ctx, {
      ...intake,
      digests: abuseFingerprints("submission", "changed"),
    }),
  ).toEqual({ outcome: "conflict" });
  expect(ctx.tables.abuse_cases).toHaveLength(1);
  expect(ctx.tables.abuse_rate_limits.every((row) => row.count === 1)).toBe(
    true,
  );
});
test("an accepted report atomically queues one notification across receipt retries", async () => {
  process.env.ABUSE_NOTIFICATIONS_ENABLED = "true";
  const ctx = { ...database(), scheduler: { runAfter: jest.fn() } };
  await invoke("receive", ctx, intake);
  await invoke("receive", ctx, intake);
  expect(ctx.tables.abuse_cases).toHaveLength(1);
  expect(ctx.tables.abuse_notifications).toHaveLength(1);
  expect(ctx.tables.abuse_notifications[0]).toMatchObject({
    status: "pending",
    attempts: 0,
    caseId: ctx.tables.abuse_cases[0]._id,
  });
  expect(ctx.scheduler.runAfter).toHaveBeenCalledTimes(1);
});
test("intake alone never restricts an account and per-email limits cannot be bypassed by rotating a retained key", async () => {
  const ctx = database();
  for (let i = 0; i < 3; i++)
    await invoke("receive", ctx, {
      ...intake,
      reference: `AB-123e4567-e89b-42d3-a456-42661417400${i}`,
    });
  expect(
    await invoke("receive", ctx, {
      ...intake,
      reference: "AB-123e4567-e89b-42d3-a456-426614174009",
      emailHashes: ["4".repeat(64), ...intake.emailHashes],
    }),
  ).toEqual({ outcome: "rate_limited" });
  expect(ctx.tables.user_suspensions).toBeUndefined();
});
test("only explicit operators can read evidence and every authorized read is audited", async () => {
  const ctx = database();
  await invoke("receive", ctx, intake);
  await expect(
    invoke("read", ctx, {
      ...operator,
      actor: "support_member",
      paginationOpts: { cursor: null, numItems: 10 },
    }),
  ).rejects.toThrow("access denied");
  const result = await invoke("read", ctx, {
    ...operator,
    paginationOpts: { cursor: null, numItems: 10 },
  });
  expect(result.case.ciphertext).toBe(ciphertext);
  expect(ctx.tables.abuse_events.map((row) => row.kind)).toEqual([
    "received",
    "read",
  ]);
});
test("queue returns only its validated pagination contract, including continuation", async () => {
  const ctx = database();
  await invoke("receive", ctx, intake);
  const result = await invoke("list", ctx, {
    ...operator,
    status: "new",
    paginationOpts: { cursor: null, numItems: 1 },
  });
  expect(Object.keys(result).sort()).toEqual([
    "continueCursor",
    "isDone",
    "page",
  ]);
  expect(result.page).toHaveLength(1);
  expect(result.page[0]).not.toHaveProperty("ciphertext");
  expect(result.isDone).toBe(true);
  expect(result.continueCursor).toBe("1");
});
test("persists bounded maximum-length non-Latin evidence after encryption", async () => {
  const ctx = database();
  process.env.ABUSE_EVIDENCE_KEYS = JSON.stringify({
    active: "test",
    keys: { test: "11".repeat(32) },
  });
  const encoded = encryptAbuseEvidence(reference, {
    description: "報".repeat(6000),
    evidence: "證".repeat(6000),
    target: "例".repeat(500),
  });
  expect(encoded.length).toBeGreaterThan(48_000);
  await expect(
    invoke("receive", ctx, { ...intake, ciphertext: encoded }),
  ).resolves.toEqual({ outcome: "received", reference });
});
test("reviewed containment is scoped and resolution leaves billing and independent security holds intact", async () => {
  const ctx = database();
  await caseWithReview(ctx);
  await ctx.db.insert("subagent_runs", {
    user_id: "subject",
    chat_id: "chat",
    parent_trigger_run_id: "run_root",
    trigger_run_id: "run_child",
    status: "running",
  });
  await ctx.db.insert("subagent_runs", {
    user_id: "other",
    chat_id: "other",
    parent_trigger_run_id: "run_other",
    trigger_run_id: "run_other_child",
    status: "running",
  });
  await ctx.db.insert("user_suspensions", {
    user_id: "subject",
    source_id: "billing",
    source: "stripe",
    category: "dispute_billing_hold",
    status: "active",
  });
  await ctx.db.insert("user_suspensions", {
    user_id: "subject",
    source_id: "independent",
    source: "support",
    category: "security_abuse",
    status: "active",
  });
  const begin = {
    ...operator,
    expectedRevision: 1,
    userId: "subject",
    chatId: "chat",
    runId: "run_root",
    transport: "local",
    decision: ciphertext,
    operationToken: "owner",
  };
  await expect(
    invoke("beginContainment", ctx, { ...begin, userId: "other" }),
  ).rejects.toThrow("ownership changed");
  expect(ctx.tables.abuse_cases[0].revision).toBe(1);
  expect(ctx.tables.user_suspensions).toHaveLength(2);
  const row = await invoke("beginContainment", ctx, begin);
  const readCase = () =>
    invoke("read", ctx, {
      ...operator,
      paginationOpts: { cursor: null, numItems: 10 },
    });
  expect((await readCase()).restrictionStatus).toBe("active");
  expect(row.containment.childRunIds).toEqual(["run_child"]);
  expect(ctx.tables.subagent_runs.map((child) => child.status)).toEqual([
    "canceled",
    "running",
  ]);
  await expect(
    invoke("resolve", ctx, {
      ...operator,
      expectedRevision: 2,
      decision: ciphertext,
    }),
  ).rejects.toThrow("in progress");
  await expect(
    invoke("recordContainment", ctx, {
      ...operator,
      operationToken: "stale",
      containment: row.containment,
      finished: true,
    }),
  ).rejects.toThrow("expired");
  await invoke("recordContainment", ctx, {
    ...operator,
    operationToken: "owner",
    containment: { ...row.containment, triggerState: "stopped" },
    finished: true,
  });
  expect(row.status).toBe("needs_followup");
  await invoke("resolve", ctx, {
    ...operator,
    expectedRevision: 3,
    decision: ciphertext,
  });
  expect(ctx.tables.user_suspensions.map((row) => row.status)).toEqual([
    "active",
    "active",
    "resolved",
  ]);
  expect(row.evidenceHold).toBe(true);
  expect((await readCase()).restrictionStatus).toBe("resolved");
  await expect(
    invoke("eraseEvidence", ctx, {
      ...operator,
      expectedRevision: 4,
      confirmation: reference,
    }),
  ).rejects.toThrow("preservation");
  await invoke("setEvidenceHold", ctx, {
    ...operator,
    expectedRevision: 4,
    hold: false,
    decision: ciphertext,
  });
  await invoke("eraseEvidence", ctx, {
    ...operator,
    expectedRevision: 5,
    confirmation: reference,
  });
  expect(row.ciphertext).toBeUndefined();
  expect(ctx.tables.abuse_events.every((event) => !event.ciphertext)).toBe(
    true,
  );
  expect(ctx.tables.abuse_events.at(-1).kind).toBe("evidence_deleted");
});
test("reports without verified attribution cannot start containment", async () => {
  const ctx = database();
  await invoke("receive", ctx, intake);
  await expect(
    invoke("beginContainment", ctx, {
      ...operator,
      expectedRevision: 0,
      userId: "subject",
      chatId: "chat",
      runId: "run_root",
      transport: "local",
      decision: ciphertext,
      operationToken: "owner",
    }),
  ).rejects.toThrow("verified attribution");
  expect(ctx.tables.user_suspensions).toBeUndefined();
});

test("a second case cannot add a competing account/workspace containment hold", async () => {
  const ctx = database();
  await caseWithReview(ctx);
  const second = "AB-123e4567-e89b-42d3-a456-426614174001";
  await invoke("receive", ctx, { ...intake, reference: second });
  await invoke("annotate", ctx, {
    ...operator,
    reference: second,
    expectedRevision: 0,
    kind: "verified_fact",
    ciphertext,
  });
  const begin = {
    ...operator,
    expectedRevision: 1,
    userId: "subject",
    chatId: "chat",
    runId: "run_root",
    transport: "cloud",
    sandboxId: "sandbox",
    region: "us-east-1",
    preserveSnapshot: false,
    decision: ciphertext,
    operationToken: "owner",
  };
  await invoke("beginContainment", ctx, begin);
  await expect(
    invoke("beginContainment", ctx, {
      ...begin,
      reference: second,
      operationToken: "competitor",
    }),
  ).rejects.toThrow("existing active containment");
  expect(ctx.tables.user_suspensions).toHaveLength(1);
  expect(ctx.tables.abuse_cases[1].containment).toBeUndefined();
});
