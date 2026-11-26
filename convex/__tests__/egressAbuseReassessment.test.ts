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
import { readCaseEvidence } from "../egressAbuseReassessmentActions";
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

// The actual reassessment action, its internal reads and the review's case
// write, against the in-memory store with real evidence encryption.

const KEY = "synthetic-egress-review-key";
const USER = "user_subject";
const CHAT = "chat_candidate";
const RUN = "run_candidate";
const OWNER = "ea9bbd5f9a7694d52393f5ae207967c5";
const MINUTE_MS = 60_000;
const WINDOW = reviewWindowStart(Math.floor(Date.now() / MINUTE_MS) - 120);
const MINUTE = WINDOW + 3;
const BURST_START = MINUTE * MINUTE_MS;
const caseKey = reviewCaseKey("us", OWNER, WINDOW);
const reference = reviewReference(caseKey);
const USER_TEXT = "Please check my staging service for open ports.";
const COMMAND = "nmap -sV 203.0.113.5";
const originalEnv = { ...process.env };

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

/** An action context whose internal calls run the actual handlers. */
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

const reassess = (ctx = actionContext(), serviceKey = KEY) =>
  (readCaseEvidence as any).handler(ctx, { serviceKey, reference });

/** The record the review stores for a `multiple_runs` case with a candidate. */
const overlapRecord = (
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
    decision: { outcome: "manual_review", reason: "multiple_runs" },
    userId: USER,
    sandboxIds: ["sandbox_1"],
    run: { chatId: CHAT, runId: RUN },
    reviewedAt: BURST_START + 30 * MINUTE_MS,
    ...overrides,
  });

async function recordCase(record: unknown = overlapRecord()) {
  await (review.recordCase as any).handler(convex, {
    serviceKey: KEY,
    reference,
    digest: reviewDigest(caseKey),
    ciphertext: encryptAbuseEvidence(reference, record),
  });
  return convex.tables.abuse_cases[0];
}

const terminal = (toolCallId: string, command: string, state: string) => ({
  type: "tool-run_terminal_cmd",
  toolCallId,
  state,
  input: { action: "exec", command },
  output: {
    result: { processStarted: true, output: "TOOL OUTPUT MUST NOT BE READ" },
  },
});

async function seedCandidate(owner = USER) {
  await convex.db.insert("chats", { id: CHAT, user_id: owner });
  await convex.db.insert("messages", {
    id: "msg-user",
    chat_id: CHAT,
    user_id: owner,
    role: "user",
    parts: [{ type: "text", text: USER_TEXT }],
  });
  await convex.db.insert("messages", {
    id: "msg-hidden",
    chat_id: CHAT,
    user_id: owner,
    role: "user",
    is_hidden: true,
    parts: [{ type: "text", text: "HIDDEN TEXT" }],
  });
  await convex.db.insert("messages", {
    id: "msg-assistant",
    chat_id: CHAT,
    user_id: owner,
    role: "assistant",
    trigger_run_id: RUN,
    generation_started_at: BURST_START - 5 * MINUTE_MS,
    generation_time_ms: 15 * MINUTE_MS,
    parts: [
      { type: "reasoning", text: "REASONING TEXT" },
      terminal("call-real-id", COMMAND, "output-available"),
      { type: "text", text: "ASSISTANT TEXT" },
    ],
  });
  // The overlap marker the original review saw: another root still active.
  await convex.db.insert("chats", {
    id: "chat_other",
    user_id: owner,
    active_trigger_run_id: "run_other",
  });
  await convex.db.insert("messages", {
    id: "msg-other",
    chat_id: "chat_other",
    user_id: owner,
    role: "user",
    parts: [{ type: "text", text: "UNRELATED CHAT TEXT" }],
  });
}

const reads = () =>
  (convex.tables.abuse_events ?? []).filter(({ kind }) => kind === "read");
const exposes = (value: unknown) => {
  const text = JSON.stringify(value);
  return [
    USER,
    CHAT,
    RUN,
    "msg-user",
    "msg-assistant",
    "call-real-id",
    "TOOL OUTPUT",
    "HIDDEN TEXT",
    "REASONING TEXT",
    "ASSISTANT TEXT",
    "UNRELATED CHAT TEXT",
  ].filter((raw) => text.includes(raw));
};

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

it("reads only the retained candidate of an overlap case and adds one audit read", async () => {
  await seedCandidate();
  const row = await recordCase();
  const before = structuredClone(row);

  const result = await reassess();
  expect(result).toEqual({
    status: "read",
    burstStart: BURST_START,
    burstEnd: BURST_START + MINUTE_MS,
    evidence: {
      status: "ok",
      userMessages: [
        {
          messageId: "r1",
          observedAt: expect.any(Number),
          text: USER_TEXT,
          truncated: false,
        },
      ],
      commands: [
        {
          messageId: "r2",
          toolCallId: "c1",
          tool: "run_terminal_cmd",
          text: COMMAND,
          truncated: false,
        },
      ],
      coverage: {
        rawReads: 3,
        historyTruncated: false,
        userMessagesOmitted: 0,
        commandsOmitted: 0,
        incompleteToolCalls: 0,
        runActive: false,
      },
    },
  });
  // Placeholders only: no account, chat, run, message or tool call identifier.
  expect(exposes(result)).toEqual([]);

  // The case and its decision are unchanged; the only write is a fixed read.
  expect(convex.tables.abuse_cases).toEqual([before]);
  expect(decryptAbuseEvidence(reference, row.ciphertext)).toEqual(
    overlapRecord(),
  );
  expect(
    convex.tables.abuse_events.map(({ actor, kind }) => [actor, kind]),
  ).toEqual([
    ["egress_abuse_review", "received"],
    ["egress_abuse_reassessment", "read"],
  ]);
  expect(reads()[0]).not.toHaveProperty("ciphertext");
  for (const table of [
    "user_suspensions",
    "abuse_block_notices",
    "abuse_notifications",
    "egress_review_receipts",
  ])
    expect(convex.tables[table] ?? []).toHaveLength(0);

  // The review and enforcement read keeps its cross-root guard.
  await expect(
    (review.readRunEvidence as any).handler(convex, {
      serviceKey: KEY,
      userId: USER,
      chatId: CHAT,
      runId: RUN,
      burstStart: BURST_START,
      burstEnd: BURST_START + MINUTE_MS,
    }),
  ).resolves.toEqual({ status: "unavailable", reason: "concurrent_run" });
});

describe("fails closed without returning evidence", () => {
  const record = (change: (value: any) => void) => {
    const value: any = overlapRecord();
    change(value);
    return value;
  };

  it.each<[string, () => Promise<unknown>, string]>([
    ["an unknown reference", async () => {}, "case_unavailable"],
    [
      "a case another source created",
      async () => {
        await recordCase();
        convex.tables.abuse_events[0].actor = "abuse_intake";
      },
      "source_mismatch",
    ],
    [
      "a record from another source",
      () => recordCase(record((value) => (value.source = "abuse_intake"))),
      "source_mismatch",
    ],
    [
      "a case for another review reason",
      () =>
        recordCase(
          overlapRecord({
            decision: {
              outcome: "manual_review",
              reason: "observation_incomplete",
            },
          }),
        ),
      "not_overlap_case",
    ],
    [
      "an overlap case that kept no candidate",
      () => recordCase(overlapRecord({ run: undefined })),
      "no_candidate",
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
      "a burst minute outside the case window",
      () =>
        recordCase(
          record(
            (value) =>
              (value.observation.burstMinuteUtc = new Date(
                (WINDOW + 30) * MINUTE_MS,
              ).toISOString()),
          ),
        ),
      "record_invalid",
    ],
    [
      "more than one counted workspace",
      () =>
        recordCase(
          overlapRecord({
            observation: {
              region: "us",
              ownerRef: OWNER,
              burstMinute: MINUTE,
              windowStart: WINDOW,
              connections: 900,
              workspaces: 2,
            },
          }),
        ),
      "record_invalid",
    ],
    [
      "an unverified account",
      () => recordCase(overlapRecord({ userId: undefined })),
      "record_invalid",
    ],
    [
      "an unexpected field",
      () => recordCase(record((value) => (value.scope = { chatId: "other" }))),
      "record_invalid",
    ],
    [
      "a stored digest that does not match the case",
      async () => {
        const row = await recordCase();
        row.digest = "f".repeat(64);
      },
      "record_invalid",
    ],
    [
      "ciphertext that cannot be decrypted",
      async () => {
        const row = await recordCase();
        row.ciphertext += "x";
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
      "erased evidence",
      async () => {
        const row = await recordCase();
        delete row.ciphertext;
      },
      "case_unavailable",
    ],
    [
      "a case older than seven days",
      async () => {
        const row = await recordCase();
        row.createdAt = Date.now() - 8 * 24 * 60 * MINUTE_MS;
      },
      "case_unavailable",
    ],
  ])("for %s", async (_label, arrange, reason) => {
    await seedCandidate();
    await arrange();
    const result = await reassess();
    expect(result).toEqual({ status: "closed", reason });
    expect(exposes(result)).toEqual([]);
  });

  it("does not audit a read it refuses before decryption", async () => {
    await seedCandidate();
    const row = await recordCase();
    row.status = "resolved";
    await reassess();
    expect(reads()).toHaveLength(0);
  });

  it("when the case changes between the audited read and the evidence read", async () => {
    await seedCandidate();
    const row = await recordCase();
    const result = await reassess(
      actionContext(async () => {
        row.status = "resolved";
        row.revision += 1;
      }),
    );
    expect(result).toEqual({ status: "closed", reason: "case_changed" });
  });

  it("when the candidate chat belongs to another account", async () => {
    await seedCandidate("user_other");
    await recordCase();
    const result = await reassess();
    expect(result).toMatchObject({
      status: "read",
      evidence: { status: "unavailable", reason: "candidate_unavailable" },
    });
    expect(JSON.stringify(result)).not.toContain(USER_TEXT);
  });

  it("when the candidate run did not overlap the burst", async () => {
    await seedCandidate();
    await recordCase();
    convex.tables.messages.find(
      ({ id }) => id === "msg-assistant",
    ).generation_started_at = BURST_START + 30 * MINUTE_MS;
    await expect(reassess()).resolves.toMatchObject({
      evidence: { status: "unavailable", reason: "run_mismatch" },
    });
  });
});

it.each<[string, () => void]>([
  ["a wrong key", () => {}],
  [
    "the review switch off",
    () => delete process.env.E2B_EGRESS_ABUSE_REVIEW_ENABLED,
  ],
  [
    "a review key equal to the general key",
    () => (process.env.CONVEX_SERVICE_ROLE_KEY = KEY),
  ],
])("refuses %s before reading a case", async (label, arrange) => {
  await seedCandidate();
  await recordCase();
  arrange();
  const ctx = actionContext();
  await expect(
    reassess(ctx, label === "a wrong key" ? "synthetic-main-key" : KEY),
  ).rejects.toThrow("Unauthorized");
  expect(ctx.runMutation).not.toHaveBeenCalled();
  expect(reads()).toHaveLength(0);
});
