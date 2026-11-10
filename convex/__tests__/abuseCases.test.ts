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
jest.mock("server-only", () => ({}));

import { database } from "../../__mocks__/abuse-database";
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
  delete process.env.ABUSE_SMTP_PASSWORD;
});
afterEach(() => {
  process.env = { ...originalEnv };
});
async function seedCase(ctx: any, data = intake) {
  const now = Date.now();
  const caseId = await ctx.db.insert("abuse_cases", {
    reference: data.reference,
    digest: data.digests[0],
    kind: data.kind,
    ciphertext: data.ciphertext,
    status: "new",
    revision: 0,
    evidenceHold: false,
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db.insert("abuse_events", {
    caseId,
    actor: "public_intake",
    kind: "received",
    createdAt: now,
  });
}
async function caseWithReview(ctx: any) {
  await seedCase(ctx);
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
test("only explicit operators can read evidence and every authorized read is audited", async () => {
  const ctx = database();
  await seedCase(ctx);
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
  await seedCase(ctx);
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
  await seedCase(ctx);
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
  await seedCase(ctx, { ...intake, reference: second });
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
