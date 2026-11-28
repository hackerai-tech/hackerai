/** @jest-environment node */
jest.mock("../lib/serviceFunctions", () => ({
  mutation: (config: unknown) => config,
  query: (config: unknown) => config,
  action: (config: unknown) => config,
  internalQuery: (config: unknown) => config,
  internalMutation: (config: unknown) => config,
}));
import { getFunctionName } from "convex/server";
import * as review from "../egressAbuseReview";
import * as reassessment from "../egressAbuseReassessment";
import { readBurstActivityEvidence } from "../egressAbuseReassessmentActions";
import { database } from "../../__mocks__/abuse-database";
import {
  decryptAbuseEvidence,
  encryptAbuseEvidence,
} from "../../lib/abuse/evidence-crypto";
import {
  buildCaseRecord,
  reviewCaseKey,
  reviewDigest,
  reviewReference,
  reviewWindowStart,
} from "../../lib/abuse/egress-review";

// The burst-activity reassessment action, its internal reads and the
// review's case write, against the in-memory store with real encryption.
// The burst is three days old, so the account kept chatting after it.

const KEY = "synthetic-egress-review-key";
const USER = "user_subject";
const CHAT = "chat_burst";
const RUN = "run_burst";
const OWNER = "ea9bbd5f9a7694d52393f5ae207967c5";
const MINUTE_MS = 60_000;
const DAY_MINUTES = 24 * 60;
const WINDOW = reviewWindowStart(
  Math.floor(Date.now() / MINUTE_MS) - 3 * DAY_MINUTES,
);
const MINUTE = WINDOW + 7;
const BURST_START = MINUTE * MINUTE_MS;
const caseKey = reviewCaseKey("us", OWNER, WINDOW);
const reference = reviewReference(caseKey);
const USER_TEXT = "Please check my staging service for open ports.";
const COMMAND = "nmap -sV 203.0.113.5";
const originalEnv = { ...process.env };
/** Minutes relative to the burst minute. */
const at = (minutes: number) => BURST_START + minutes * MINUTE_MS;

let convex: ReturnType<typeof reviewDatabase>;

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

function actionContext(afterOpen?: () => Promise<void>) {
  const modules: Record<string, any> = {
    egressAbuseReassessment: reassessment,
  };
  const call = async (ref: unknown, args: unknown) => {
    const [module, name] = getFunctionName(ref as never).split(":");
    const result = await modules[module][name].handler(convex, args);
    if (name === "openCase") await afterOpen?.();
    return result;
  };
  return { runMutation: jest.fn(call), runQuery: jest.fn(call) };
}

const reassess = (ctx = actionContext()) =>
  (readBurstActivityEvidence as any).handler(ctx, {
    serviceKey: KEY,
    reference,
  });

/** An account-activity case the review stored shortly after the burst. */
const burstRecord = (
  overrides: Partial<Parameters<typeof buildCaseRecord>[0]> = {},
) =>
  buildCaseRecord({
    reference,
    observation: {
      region: "us",
      ownerRef: OWNER,
      burstMinute: MINUTE,
      windowStart: WINDOW,
      connections: 900,
      workspaces: 1,
    },
    decision: { outcome: "manual_review", reason: "no_acquisition_link" },
    userId: USER,
    sandboxIds: ["sandbox_1"],
    accountActivity: { status: "unavailable" },
    reviewedAt: at(30),
    ...overrides,
  });

async function recordCase(record: unknown = burstRecord()) {
  await (review.recordCase as any).handler(convex, {
    serviceKey: KEY,
    reference,
    digest: reviewDigest(caseKey),
    ciphertext: encryptAbuseEvidence(reference, record),
  });
  const row = convex.tables.abuse_cases[0];
  row.createdAt = row.updatedAt = at(31);
  return row;
}

const terminal = (toolCallId: string, command: string) => ({
  type: "tool-run_terminal_cmd",
  toolCallId,
  state: "output-available",
  input: { action: "exec", command },
  output: {
    result: { processStarted: true, output: "TOOL OUTPUT MUST NOT BE READ" },
  },
});

const chat = (id: string, created: number, extra: object = {}) =>
  convex.db.insert("chats", {
    id,
    user_id: USER,
    // Every chat was updated after the burst.
    update_time: Date.now() - MINUTE_MS,
    _creationTime: created,
    ...extra,
  });
const userRow = (id: string, chatId: string, created: number, text: string) =>
  convex.db.insert("messages", {
    id,
    chat_id: chatId,
    user_id: USER,
    role: "user",
    update_time: created,
    _creationTime: created,
    parts: [{ type: "text", text }],
  });
const runRow = (
  id: string,
  chatId: string,
  runId: string,
  timing: { start: number; minutes?: number; saved: number },
  command: string,
) =>
  convex.db.insert("messages", {
    id,
    chat_id: chatId,
    user_id: USER,
    role: "assistant",
    trigger_run_id: runId,
    terminal_evidence_state: "complete",
    generation_started_at: timing.start,
    ...(timing.minutes === undefined
      ? {}
      : { generation_time_ms: timing.minutes * MINUTE_MS }),
    update_time: timing.saved,
    _creationTime: timing.saved,
    parts: [
      { type: "reasoning", text: "REASONING TEXT" },
      terminal(`call-${id}`, command),
      { type: "text", text: "ASSISTANT TEXT" },
    ],
  });

/**
 * One chat whose run spanned the burst and saved 11 minutes after it, then
 * later turns, a chat created after the burst, and another account's chat.
 */
async function seedBurst({ saved = at(11) } = {}) {
  await chat(CHAT, at(-120));
  await userRow("msg-user", CHAT, at(-6), USER_TEXT);
  await convex.db.insert("messages", {
    id: "msg-hidden",
    chat_id: CHAT,
    user_id: USER,
    role: "user",
    is_hidden: true,
    update_time: at(-6) + 1,
    _creationTime: at(-6) + 1,
    parts: [{ type: "text", text: "HIDDEN TEXT" }],
  });
  await runRow(
    "msg-assistant",
    CHAT,
    RUN,
    { start: at(-5), minutes: 15, saved },
    COMMAND,
  );
  // A later run of the same chat inside the read range, after the burst.
  await userRow("msg-post-user", CHAT, at(12), "POST TEXT");
  await runRow(
    "msg-post",
    CHAT,
    "run_post",
    { start: at(13), minutes: 2, saved: at(16) },
    "POST COMMAND",
  );
  // More saved rows after the read range than the per-chat row limit.
  for (let index = 0; index < 100; index++)
    await userRow(`msg-later-${index}`, CHAT, at(120) + index, "LATER TEXT");
  await chat("chat_after", at(60));
  await userRow("msg-after", "chat_after", at(60), "NEW CHAT TEXT");
  await runRow(
    "msg-after-run",
    "chat_after",
    "run_after",
    { start: at(61), minutes: 1, saved: at(62) },
    "NEW CHAT COMMAND",
  );
  await convex.db.insert("chats", {
    id: "chat_foreign",
    user_id: "user_other",
    update_time: Date.now(),
    _creationTime: at(-120),
  });
  await convex.db.insert("messages", {
    id: "msg-foreign",
    chat_id: "chat_foreign",
    user_id: "user_other",
    role: "assistant",
    trigger_run_id: "run_foreign",
    generation_started_at: at(-1),
    generation_time_ms: 5 * MINUTE_MS,
    update_time: at(4),
    _creationTime: at(4),
    parts: [terminal("call-foreign", "FOREIGN COMMAND")],
  });
}

const messageReads = () => convex.tables.messages;
const exposes = (value: unknown) => {
  const text = JSON.stringify(value);
  return [
    USER,
    CHAT,
    RUN,
    "msg-user",
    "msg-assistant",
    "call-msg-assistant",
    "TOOL OUTPUT",
    "HIDDEN TEXT",
    "REASONING TEXT",
    "ASSISTANT TEXT",
    "POST",
    "LATER TEXT",
    "NEW CHAT",
    "FOREIGN",
    "EARLIER",
  ].filter((raw) => text.includes(raw));
};
const find = (id: string) => messageReads().find((row: any) => row.id === id);

beforeEach(() => {
  process.env.E2B_EGRESS_ABUSE_REVIEW_ENABLED = "true";
  process.env.CONVEX_EGRESS_ABUSE_REVIEW_SERVICE_KEY = KEY;
  process.env.CONVEX_SERVICE_ROLE_KEY = "synthetic-main-key";
  process.env.CONVEX_CLOUD_URL = "https://fixture.convex.cloud";
  process.env.ABUSE_EVIDENCE_KEYS = JSON.stringify({
    active: "k1",
    keys: { k1: "ab".repeat(32) },
  });
  convex = reviewDatabase();
});
afterEach(() => {
  process.env = { ...originalEnv };
});

const completeSelection = {
  chatsScanned: 1,
  chatsAfterBurst: 1,
  scanTruncated: false,
  otherOverlappingRuns: 0,
  unplacedRuns: 0,
  lateSave: false,
};

it("reads only the overlapping run of a historical burst, not later activity", async () => {
  await seedBurst();
  const row = await recordCase();
  const before = structuredClone(row);

  const result = await reassess();

  expect(result).toEqual({
    status: "read",
    burstStart: BURST_START,
    burstEnd: BURST_START + MINUTE_MS,
    minuteBasis: "saved_case",
    evidence: {
      status: "ok",
      selection: completeSelection,
      candidate: {
        status: "found",
        runId: RUN,
        userMessages: [{ messageId: "r1", text: USER_TEXT, truncated: false }],
        commands: [
          {
            messageId: "r2",
            toolCallId: "c1",
            tool: "run_terminal_cmd",
            text: COMMAND,
            truncated: false,
          },
        ],
        // The 100 later rows were neither read nor counted as truncation.
        coverage: {
          rawReads: 5,
          historyTruncated: false,
          userMessagesOmitted: 0,
          commandsOmitted: 0,
          incompleteToolCalls: 0,
          runActive: false,
        },
      },
    },
  });
  // The worker needs the run ID to verify completion; evidence uses placeholders.
  expect(exposes(result)).toEqual([RUN]);

  // The case and its decision are unchanged; the only write is a fixed read.
  expect(convex.tables.abuse_cases).toEqual([before]);
  expect(decryptAbuseEvidence(reference, row.ciphertext)).toEqual(
    burstRecord(),
  );
  expect(
    convex.tables.abuse_events.map(({ actor, kind }) => [actor, kind]),
  ).toEqual([
    ["egress_abuse_review", "received"],
    ["egress_abuse_reassessment", "read"],
  ]);
  for (const table of [
    "user_suspensions",
    "abuse_block_notices",
    "abuse_notifications",
    "egress_review_receipts",
  ])
    expect(convex.tables[table] ?? []).toHaveLength(0);
});

it("finds an overlapping run even when later chats dominate update order", async () => {
  await seedBurst();
  for (let index = 0; index < 25; index++) {
    await chat(`chat-after-${index}`, at(40) + index, {
      update_time: Date.now() - 1_000 - index,
    });
  }
  await recordCase();

  const { evidence } = await reassess();
  expect(evidence.candidate).toMatchObject({
    status: "found",
    runId: RUN,
    commands: [{ text: COMMAND }],
  });
  expect(evidence.selection).toMatchObject({
    chatsScanned: 1,
    chatsAfterBurst: 26,
    scanTruncated: false,
  });
});

it("keeps discovered evidence when later chats could exhaust the byte budget", async () => {
  await seedBurst();
  for (let index = 0; index < 19; index++)
    await chat(`chat-during-${index}`, at(-120), {
      update_time: Date.now() - 1_000 - index,
    });
  const oversizedTitle = "x".repeat(950_000);
  for (let index = 0; index < 7; index++)
    await chat(`chat-large-after-${index}`, at(40) + index, {
      update_time: Date.now() - 120_000 - index,
      title: oversizedTitle,
    });
  await recordCase();

  const { evidence } = await reassess();
  expect(evidence.candidate).toMatchObject({
    status: "found",
    runId: RUN,
    commands: [{ text: COMMAND }],
  });
  expect(evidence.selection).toMatchObject({
    chatsScanned: 20,
    scanTruncated: true,
  });
});

it("reports a run that saved after the read range instead of no activity", async () => {
  await seedBurst({ saved: at(45) });
  await recordCase();
  const { evidence } = await reassess();
  expect(evidence).toEqual({
    status: "ok",
    selection: { ...completeSelection, lateSave: true },
    candidate: { status: "none" },
  });
});

it("marks the candidate incomplete when its run saved another row later", async () => {
  await seedBurst();
  await runRow(
    "msg-assistant-late",
    CHAT,
    RUN,
    { start: at(-5), minutes: 40, saved: at(45) },
    "LATE COMMAND",
  );
  await recordCase();
  const { evidence } = await reassess();
  expect(evidence.selection).toEqual(completeSelection);
  expect(evidence.candidate.coverage.commandsOmitted).toBe(1);
  expect(JSON.stringify(evidence)).not.toContain("LATE COMMAND");
});

it("keeps the candidate's commands and withholds context alone when the request changed", async () => {
  await seedBurst();
  await userRow("msg-earlier-user", CHAT, at(-60), "EARLIER SCOPE TEXT");
  await runRow(
    "msg-earlier",
    CHAT,
    "run_earlier",
    { start: at(-59), minutes: 2, saved: at(-57) },
    "EARLIER COMMAND",
  );
  // The request was edited after the run started.
  find("msg-user").update_time = at(0);
  await recordCase();

  const { evidence } = await reassess();

  expect(evidence.selection).toEqual(completeSelection);
  expect(evidence.candidate).toMatchObject({
    status: "found",
    userMessages: [],
    commands: [{ text: COMMAND }],
    coverage: { userMessagesOmitted: 1, commandsOmitted: 0 },
  });
  expect(exposes(evidence)).toEqual([RUN]);
});

it("selects the most recently started overlapping run and counts the others", async () => {
  await seedBurst();
  await chat("chat_long", at(-180));
  await userRow("msg-long-user", "chat_long", at(-31), "LONG TEXT");
  await runRow(
    "msg-long",
    "chat_long",
    "run_long",
    { start: at(-30), minutes: 40, saved: at(10) },
    "LONG COMMAND",
  );
  // Started last, but still marked active: never the finished candidate.
  await chat("chat_active", at(-180), { active_trigger_run_id: "run_active" });
  await runRow(
    "msg-active",
    "chat_active",
    "run_active",
    { start: at(-2), minutes: 5, saved: at(3) },
    "ACTIVE COMMAND",
  );
  await recordCase();

  const { evidence } = await reassess();

  expect(evidence.candidate).toMatchObject({ commands: [{ text: COMMAND }] });
  expect(evidence.selection).toEqual({
    ...completeSelection,
    chatsScanned: 3,
    otherOverlappingRuns: 2,
  });
  expect(JSON.stringify(evidence)).not.toMatch(/LONG|ACTIVE/);
});

it("counts a run without persisted timing as unplaced, never as the candidate", async () => {
  await seedBurst();
  delete find("msg-assistant").generation_time_ms;
  await recordCase();
  const { evidence } = await reassess();
  expect(evidence).toEqual({
    status: "ok",
    selection: { ...completeSelection, unplacedRuns: 1 },
    candidate: { status: "none" },
  });
});

it("returns no content when a subagent of the candidate may have overlapped", async () => {
  await seedBurst();
  await convex.db.insert("subagent_runs", {
    user_id: USER,
    chat_id: CHAT,
    parent_trigger_run_id: RUN,
    trigger_run_id: "run_child",
    status: "completed",
    created_at: at(-3),
    started_at: at(-3),
    completed_at: at(4),
  });
  await recordCase();
  const result = await reassess();
  expect(result.evidence).toEqual({
    status: "ok",
    selection: completeSelection,
    candidate: { status: "subagent_overlap" },
  });
  expect(exposes(result)).toEqual([]);
});

it("reads nothing for an account being deleted, and skips deleted chats", async () => {
  await seedBurst();
  await recordCase();
  convex.tables.chats.find(({ id }: any) => id === CHAT).deletion_started_at =
    1;
  await expect(reassess()).resolves.toMatchObject({
    evidence: {
      selection: { chatsScanned: 0 },
      candidate: { status: "none" },
    },
  });

  await convex.db.insert("user_deletion_fences", { user_id: USER });
  const result = await reassess();
  expect(result.evidence).toEqual({
    status: "unavailable",
    reason: "account_unavailable",
  });
  expect(exposes(result)).toEqual([]);
});

it("reads an authorization request case's burst", async () => {
  await seedBurst();
  await recordCase(
    burstRecord({
      decision: {
        outcome: "authorization_request",
        reason: "concerning_unauthorized",
      },
      accountActivity: undefined,
      run: { chatId: CHAT, runId: RUN, runStart: at(-5), runEnd: at(10) },
    }),
  );
  await expect(reassess()).resolves.toMatchObject({
    status: "read",
    evidence: { candidate: { status: "found" } },
  });
});

describe("fails closed without reading activity", () => {
  const record = (change: (value: any) => void) => {
    const value: any = burstRecord();
    change(value);
    return value;
  };
  const enforcement = {
    decision: "enforcement_pending",
    reason: "enforcement_refused",
    refusal: "case_exists",
    intentKind: "unauthorized_access",
    policyVersion: "egress-enforcement-v1",
    promptVersion: "egress-abuse-review-v2",
    locators: { commands: [], messages: [] },
  } as const;

  it.each<[string, () => Promise<unknown>, string]>([
    ["an unknown reference", async () => {}, "case_unavailable"],
    [
      "a recorded enforcement decision",
      () => recordCase(burstRecord({ enforcement })),
      "enforcement_recorded",
    ],
    [
      "a record without its enforcement field",
      () => recordCase(record((value) => delete value.enforcement)),
      "record_invalid",
    ],
    [
      "an unverified account",
      () =>
        recordCase(
          burstRecord({
            decision: {
              outcome: "manual_review",
              reason: "attribution_unverified",
            },
            userId: undefined,
          }),
        ),
      "account_unverified",
    ],
    [
      "a record from another source",
      () => recordCase(record((value) => (value.source = "abuse_intake"))),
      "source_mismatch",
    ],
    [
      "a case another source created",
      async () => {
        await recordCase();
        convex.tables.abuse_events[0].actor = "abuse_intake";
      },
      "source_mismatch",
    ],
    [
      "an earlier record version",
      () => recordCase(record((value) => (value.version = 2))),
      "record_invalid",
    ],
    [
      "an outcome that does not match its reason",
      () =>
        recordCase(
          record((value) => (value.outcome = "authorization_request")),
        ),
      "record_invalid",
    ],
    [
      "a fractional connection count",
      () =>
        recordCase(record((value) => (value.observation.connections = 900.5))),
      "record_invalid",
    ],
    [
      "a record whose owner does not hash to the case",
      () =>
        recordCase(
          record((value) => (value.observation.ownerRef = "0".repeat(32))),
        ),
      "record_invalid",
    ],
    [
      "a review recorded before the burst minute ended",
      () =>
        recordCase(
          record(
            (value) =>
              (value.reviewedAt = new Date(BURST_START + 1).toISOString()),
          ),
        ),
      "record_invalid",
    ],
    [
      "a burst more than a day before the case",
      async () => {
        const row = await recordCase();
        row.createdAt = at(25 * 60);
      },
      "record_invalid",
    ],
    [
      "a resolved case",
      async () => {
        const row = await recordCase();
        row.status = "resolved";
      },
      "case_unavailable",
    ],
    [
      "a contained case",
      async () => {
        const row = await recordCase();
        row.containment = { kind: "restriction" };
      },
      "case_unavailable",
    ],
    [
      "erased evidence",
      async () => {
        const row = await recordCase();
        delete row.ciphertext;
      },
      "case_unavailable",
    ],
  ])("for %s", async (_label, arrange, reason) => {
    await seedBurst();
    await arrange();
    const ctx = actionContext();
    const result = await reassess(ctx);
    expect(result).toEqual({ status: "closed", reason });
    // The activity read never ran.
    expect(ctx.runQuery).not.toHaveBeenCalled();
  });

  it("when the case changes between the audited read and the activity read", async () => {
    await seedBurst();
    const row = await recordCase();
    const result = await reassess(
      actionContext(async () => {
        row.revision += 1;
      }),
    );
    expect(result).toEqual({ status: "closed", reason: "case_changed" });
  });
});
