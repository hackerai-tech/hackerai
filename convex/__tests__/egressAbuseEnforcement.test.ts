/** @jest-environment node */
jest.mock("../lib/serviceFunctions", () => ({
  mutation: (config: unknown) => config,
  query: (config: unknown) => config,
  internalMutation: (config: unknown) => config,
}));
import { webcrypto } from "node:crypto";
import { signServiceArgs } from "../../lib/db/service-proof";
import {
  VERIFIED_EGRESS_BLOCK_SCOPE,
  egressEvidenceFingerprint,
} from "../../lib/abuse/egress-outcomes";
import * as enforcement from "../egressAbuseEnforcement";
import * as notices from "../abuseBlockNotices";
import * as review from "../egressAbuseReview";
import * as cases from "../abuseCases";
import { database } from "../../__mocks__/abuse-database";

Object.defineProperty(globalThis, "crypto", {
  value: webcrypto,
  configurable: true,
});

// Synthetic placeholders only: no real account, chat, target or credential.
const DEPLOYMENT = "https://fixture.convex.cloud";
const ENFORCEMENT_KEY = "synthetic-enforcement-key";
const DISPATCH_KEY = "synthetic-dispatch-key";
const REVIEW_KEY = "synthetic-review-key";
const MAIN_KEY = "synthetic-main-key";
const USER = "user_subject";
const CHAT = "chat_1";
const RUN = "run_parent1";
const REFERENCE = "AB-0123abcd-0123-4abc-8abc-0123456789ab";
const DIGEST = "d".repeat(64);
const CIPHERTEXT = "v1.k1.nonce.tag.data";
const MINUTE_MS = 60_000;
const original = { ...process.env };
let burst: { burstStart: number; burstEnd: number };

beforeEach(() => {
  process.env = {
    ...original,
    CONVEX_CLOUD_URL: DEPLOYMENT,
    E2B_EGRESS_ABUSE_REVIEW_ENABLED: "true",
    E2B_EGRESS_ABUSE_ENFORCEMENT_ENABLED: "true",
    ABUSE_BLOCK_NOTICE_DISPATCH_ENABLED: "true",
    CONVEX_EGRESS_ABUSE_ENFORCEMENT_SERVICE_KEY: ENFORCEMENT_KEY,
    CONVEX_ABUSE_NOTICE_DISPATCH_SERVICE_KEY: DISPATCH_KEY,
    CONVEX_EGRESS_ABUSE_REVIEW_SERVICE_KEY: REVIEW_KEY,
    CONVEX_SERVICE_ROLE_KEY: MAIN_KEY,
    ABUSE_OPERATOR_USER_IDS: "operator_1",
    ABUSE_EVIDENCE_KEYS: JSON.stringify({
      active: "k1",
      keys: { k1: "ab".repeat(32) },
    }),
  };
  const minute = Math.floor(Date.now() / MINUTE_MS) - 30;
  burst = {
    burstStart: minute * MINUTE_MS,
    burstEnd: (minute + 1) * MINUTE_MS,
  };
});
afterAll(() => {
  process.env = original;
});

const call = (module: any, name: string, ctx: any, args: any) =>
  module[name].handler(ctx, args);
const blockArgs = (overrides: Record<string, unknown> = {}) => ({
  serviceKey: ENFORCEMENT_KEY,
  reference: REFERENCE,
  digest: DIGEST,
  ciphertext: CIPHERTEXT,
  userId: USER,
  chatId: CHAT,
  runId: RUN,
  ...burst,
  policyVersion: "egress-enforcement-v1",
  intentKind: "service_disruption",
  messageIds: ["m-user"],
  commands: [{ messageId: "m-assistant", toolCallId: "call-1" }],
  ...overrides,
});
async function verifiedBlockArgs(
  ctx: any,
  overrides?: Record<string, unknown>,
) {
  const current = await review.collectRunEvidence(ctx, {
    ...burst,
    userId: USER,
    chatId: CHAT,
    runId: RUN,
  });
  const { serviceKey, ...inputs } = blockArgs({
    evidenceFingerprint:
      current.status === "ok"
        ? await egressEvidenceFingerprint(current)
        : "0".repeat(64),
    ...overrides,
  });
  const proof = await signServiceArgs(
    {
      deployment: DEPLOYMENT,
      name: VERIFIED_EGRESS_BLOCK_SCOPE,
      type: "mutation",
    },
    { ...inputs, serviceKey: REVIEW_KEY },
  );
  return { ...inputs, serviceKey, reviewProof: proof.serviceKey };
}

const apply = async (ctx: any, overrides?: Record<string, unknown>) =>
  call(enforcement, "applyBlock", ctx, await verifiedBlockArgs(ctx, overrides));
const claim = (ctx: any, leaseToken = crypto.randomUUID()) =>
  call(notices, "claim", ctx, { serviceKey: DISPATCH_KEY, leaseToken });
const ack = (ctx: any, noticeId: string, leaseToken: string, result: string) =>
  call(notices, "ack", ctx, {
    serviceKey: DISPATCH_KEY,
    noticeId,
    leaseToken,
    result,
  });
const summary = (ctx: any) =>
  call(notices, "summary", ctx, { serviceKey: DISPATCH_KEY });

async function seed(ctx: any, chat: Record<string, unknown> = {}) {
  await ctx.db.insert("chats", { id: CHAT, user_id: USER, ...chat });
  await ctx.db.insert("messages", {
    id: "m-user",
    chat_id: CHAT,
    user_id: USER,
    role: "user",
    parts: [{ type: "text", text: "synthetic request" }],
  });
  await ctx.db.insert("messages", {
    id: "m-assistant",
    chat_id: CHAT,
    user_id: USER,
    role: "assistant",
    trigger_run_id: RUN,
    terminal_evidence_state: "complete",
    generation_started_at: burst.burstStart - 5 * MINUTE_MS,
    generation_time_ms: 10 * MINUTE_MS,
    parts: [
      {
        type: "tool-run_terminal_cmd",
        toolCallId: "call-1",
        state: "output-available",
        input: { action: "exec", command: "synthetic placeholder" },
        output: { result: { processStarted: true } },
      },
    ],
  });
  await ctx.db.insert("local_sandbox_tokens", {
    user_id: USER,
    token: "synthetic-local-token",
    token_created_at: 1,
    updated_at: 1,
  });
  await ctx.db.insert("local_sandbox_connections", {
    user_id: USER,
    status: "connected",
  });
}

const restrictiveTables = [
  "abuse_cases",
  "abuse_events",
  "user_suspensions",
  "abuse_responses",
  "abuse_block_notices",
  "egress_review_receipts",
];
const rowCounts = (ctx: any) =>
  restrictiveTables.map((table) => (ctx.tables[table] ?? []).length);

describe("applyBlock", () => {
  it("creates the case, restriction, local revocation, response and notice together", async () => {
    const ctx = database();
    await seed(ctx);
    await expect(apply(ctx)).resolves.toEqual({
      outcome: "applied",
      restriction: "created",
      notice: "queued",
    });
    const [row] = ctx.tables.abuse_cases;
    expect(row).toMatchObject({
      reference: REFERENCE,
      status: "needs_followup",
      evidenceHold: true,
      activeContainmentUserId: USER,
    });
    expect(ctx.tables.user_suspensions).toEqual([
      expect.objectContaining({
        user_id: USER,
        status: "active",
        category: "security_abuse",
        source: "support",
        source_id: `abuse-late:${REFERENCE}`,
        source_reason: "automated_egress_abuse_block",
      }),
    ]);
    const [token] = ctx.tables.local_sandbox_tokens;
    expect(token.token).not.toBe("synthetic-local-token");
    expect(token.revoked_source_id).toBe(`abuse-late:${REFERENCE}`);
    expect(ctx.tables.local_sandbox_connections[0].status).toBe("disconnected");
    // The existing response row, so operators resume and resolve as usual,
    // without a lease and without any cancelled run.
    const [response] = ctx.tables.abuse_responses;
    expect(response).toMatchObject({
      caseId: row._id,
      actor: "egress_abuse_enforcement",
      userId: USER,
      chatId: CHAT,
      runId: RUN,
      transport: "cloud",
      discoveryPhase: "roots",
      targets: [],
    });
    expect(response.operationExpiresAt).toBeUndefined();
    const [notice] = ctx.tables.abuse_block_notices;
    expect(notice).toMatchObject({
      caseId: row._id,
      status: "pending",
      suspensionId: response.suspensionId,
      templateVersion: "abuse-block-notice-v1",
    });
    expect(notice.messageId).toMatch(
      /^<abuse-block\.[a-f0-9]{40}@hackerai\.co>$/,
    );
    expect(ctx.tables.egress_review_receipts).toEqual([
      expect.objectContaining({
        digest: DIGEST,
        reference: REFERENCE,
        decision: "block_applied",
        reason: "harmful_intent_confirmed",
        intentKind: "service_disruption",
      }),
    ]);
    // Audit events carry actors and kinds only.
    expect(
      ctx.tables.abuse_events.map(({ actor, kind, ciphertext }: any) => [
        actor,
        kind,
        ciphertext,
      ]),
    ).toEqual([
      ["egress_abuse_review", "received", undefined],
      ["egress_abuse_enforcement", "decision", undefined],
      ["egress_abuse_enforcement", "containment_started", undefined],
    ]);
  });

  it("requires the review worker proof and binds it to the exact request", async () => {
    const ctx = database();
    await seed(ctx);
    const args = await verifiedBlockArgs(ctx);
    for (const changed of [
      { ...args, reviewProof: "" },
      { ...args, digest: "0".repeat(64) },
    ]) {
      await expect(
        call(enforcement, "applyBlock", ctx, changed),
      ).resolves.toEqual({
        outcome: "refused",
        refusal: "evidence_mismatch",
      });
    }
    expect(rowCounts(ctx)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("abstains if the verified message or command changed after analysis", async () => {
    const ctx = database();
    await seed(ctx);
    const args = await verifiedBlockArgs(ctx);
    await ctx.db.patch(ctx.tables.messages[0]._id, {
      parts: [{ type: "text", text: "synthetic edited context" }],
    });
    await expect(call(enforcement, "applyBlock", ctx, args)).resolves.toEqual({
      outcome: "refused",
      refusal: "evidence_mismatch",
    });
    expect(rowCounts(ctx)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("supersedes an earlier no-case receipt when the same window produces a block", async () => {
    const ctx = database();
    await seed(ctx);
    await call(review, "recordReceipt", ctx, {
      serviceKey: REVIEW_KEY,
      digest: DIGEST,
      decision: "keep_active",
      reason: "legitimate_corroborated",
      reviewReason: "legitimate_corroborated",
      evidenceMode: "exact_run",
      coverage: "complete",
      caseOutcome: "none",
    });
    await apply(ctx);
    const report = await summary(ctx);
    expect(report.reviews).toMatchObject({
      total: 1,
      decisions: { block_applied: 1, keep_active: 0 },
    });
  });

  it("returns the recorded block on a duplicate retry without writing again", async () => {
    const ctx = database();
    await seed(ctx);
    await apply(ctx);
    const before = rowCounts(ctx);
    await expect(apply(ctx)).resolves.toEqual({ outcome: "existing_block" });
    expect(rowCounts(ctx)).toEqual(before);
  });

  it("never acts on an existing case of the window, whatever its state", async () => {
    for (const status of ["new", "resolved"]) {
      const ctx = database();
      await seed(ctx);
      await call(review, "recordCase", ctx, {
        serviceKey: REVIEW_KEY,
        reference: REFERENCE,
        digest: DIGEST,
        ciphertext: CIPHERTEXT,
      });
      ctx.tables.abuse_cases[0].status = status;
      if (status === "resolved") delete ctx.tables.abuse_cases[0].ciphertext;
      await expect(apply(ctx)).resolves.toEqual({
        outcome: "refused",
        refusal: "case_exists",
      });
      expect(ctx.tables.user_suspensions ?? []).toHaveLength(0);
      expect(ctx.tables.abuse_block_notices ?? []).toHaveLength(0);
    }
  });

  it.each([
    [
      "a cited message from another account",
      async (ctx: any) => {
        ctx.tables.messages[0].user_id = "user_other";
      },
      "evidence_mismatch",
    ],
    [
      "a cited call of a different run",
      async (ctx: any) => {
        ctx.tables.messages[1].trigger_run_id = "run_other";
      },
      "run_unverified",
    ],
    [
      "a cited call without a start receipt",
      async (ctx: any) => {
        ctx.tables.messages[1].parts[0].output = { result: {} };
      },
      "evidence_mismatch",
    ],
    [
      "a row saved before terminal evidence provenance",
      async (ctx: any) => {
        delete ctx.tables.messages[1].terminal_evidence_state;
      },
      "evidence_mismatch",
    ],
    [
      "a browser snapshot of the run",
      async (ctx: any) => {
        ctx.tables.messages[1].terminal_evidence_state = "unverified";
      },
      "evidence_mismatch",
    ],
    [
      "a worker save whose storage compaction lost terminal evidence",
      async (ctx: any) => {
        ctx.tables.messages[1].terminal_evidence_state = "incomplete";
      },
      "evidence_mismatch",
    ],
    [
      "a compacted start receipt on a row the worker did not attest",
      async (ctx: any) => {
        const row = ctx.tables.messages[1];
        delete row.terminal_evidence_state;
        row.parts[0] = {
          ...row.parts[0],
          output: "[Terminal: ran 'synthetic placeholder', exit code 0]",
          terminalStartReceipt: true,
        };
      },
      "evidence_mismatch",
    ],
    [
      "an unfinished assistant row",
      async (ctx: any) => {
        delete ctx.tables.messages[1].generation_time_ms;
      },
      "run_unverified",
    ],
    [
      "a run that is still active",
      async (ctx: any) => {
        ctx.tables.chats[0].active_trigger_run_id = RUN;
      },
      "run_active",
    ],
    [
      "an active subagent of the run",
      async (ctx: any) => {
        await ctx.db.insert("subagent_runs", {
          user_id: USER,
          chat_id: CHAT,
          parent_trigger_run_id: RUN,
          status: "running",
        });
      },
      "run_active",
    ],
    [
      "a chat owned by another account",
      async (ctx: any) => {
        ctx.tables.chats[0].user_id = "user_other";
      },
      "account_unavailable",
    ],
    [
      "an account being deleted",
      async (ctx: any) => {
        await ctx.db.insert("user_deletion_fences", {
          user_id: USER,
          started_at: 1,
        });
      },
      "account_unavailable",
    ],
    [
      "another case already containing the account",
      async (ctx: any) => {
        await ctx.db.insert("abuse_cases", {
          reference: "AB-ffffffff-0123-4abc-8abc-0123456789ab",
          activeContainmentUserId: USER,
        });
      },
      "competing_case",
    ],
  ])("refuses %s without writing", async (_label, change, refusal) => {
    const ctx = database();
    await seed(ctx);
    await change(ctx);
    const before = rowCounts(ctx);
    await expect(apply(ctx)).resolves.toEqual({ outcome: "refused", refusal });
    expect(rowCounts(ctx)).toEqual(before);
    expect(ctx.tables.local_sandbox_tokens[0].token).toBe(
      "synthetic-local-token",
    );
  });

  it("accepts a compacted start receipt on a worker-attested row", async () => {
    const ctx = database();
    await seed(ctx);
    const row = ctx.tables.messages[1];
    row.parts[0] = {
      ...row.parts[0],
      output: "[Terminal: ran 'synthetic placeholder', exit code 0]",
      terminalStartReceipt: true,
    };
    await expect(apply(ctx)).resolves.toMatchObject({ outcome: "applied" });
  });

  it("refuses an old or future burst as retroactive", async () => {
    const ctx = database();
    await seed(ctx);
    const old = Date.now() - 25 * 60 * MINUTE_MS;
    await expect(
      apply(ctx, { burstStart: old, burstEnd: old + MINUTE_MS }),
    ).resolves.toEqual({ outcome: "refused", refusal: "stale_burst" });
    const future = Date.now() + 10 * MINUTE_MS;
    await expect(
      apply(ctx, { burstStart: future, burstEnd: future + MINUTE_MS }),
    ).resolves.toEqual({ outcome: "refused", refusal: "stale_burst" });
  });

  it("rejects other credentials, a disabled switch and an unknown policy", async () => {
    const ctx = database();
    await seed(ctx);
    for (const serviceKey of [REVIEW_KEY, DISPATCH_KEY, MAIN_KEY])
      await expect(apply(ctx, { serviceKey })).rejects.toThrow(/Unauthorized/);
    // The kill switch refuses an authenticated worker without reading.
    process.env.E2B_EGRESS_ABUSE_ENFORCEMENT_ENABLED = "false";
    await expect(apply(ctx)).resolves.toEqual({
      outcome: "refused",
      refusal: "enforcement_disabled",
    });
    await expect(apply(ctx, { serviceKey: REVIEW_KEY })).rejects.toThrow(
      /Unauthorized/,
    );
    process.env.E2B_EGRESS_ABUSE_ENFORCEMENT_ENABLED = "true";
    process.env.CONVEX_EGRESS_ABUSE_ENFORCEMENT_SERVICE_KEY = REVIEW_KEY;
    await expect(apply(ctx, { serviceKey: REVIEW_KEY })).rejects.toThrow(
      /Unauthorized/,
    );
    process.env.CONVEX_EGRESS_ABUSE_ENFORCEMENT_SERVICE_KEY = ENFORCEMENT_KEY;
    await expect(apply(ctx, { policyVersion: "v0" })).rejects.toThrow(
      "Invalid enforcement request",
    );
    expect(rowCounts(ctx).every((count) => count === 0)).toBe(true);
  });

  it("is restored by resolving the case through the existing operator flow", async () => {
    const ctx = database();
    await seed(ctx);
    await apply(ctx);
    await call(cases, "resolve", ctx, {
      serviceKey: MAIN_KEY,
      actor: "operator_1",
      reference: REFERENCE,
      expectedRevision: 1,
      decision: "v1.k1.nonce.tag.data",
    });
    expect(ctx.tables.user_suspensions[0]).toMatchObject({
      status: "resolved",
      resolved_reason: "case_review_completed",
    });
    expect(ctx.tables.local_sandbox_tokens).toHaveLength(0);
    // A notice for a lifted block is cancelled instead of sent.
    await expect(claim(ctx)).resolves.toEqual({ status: "empty" });
    expect(ctx.tables.abuse_block_notices[0]).toMatchObject({
      status: "cancelled",
      failure: "restriction_inactive",
    });
  });
});

describe("notice outbox", () => {
  async function blocked() {
    const ctx = database();
    await seed(ctx);
    await apply(ctx);
    return ctx;
  }

  it("claims only for the dispatcher and records an accepted send once", async () => {
    const ctx = await blocked();
    await expect(
      call(notices, "claim", ctx, {
        serviceKey: ENFORCEMENT_KEY,
        leaseToken: crypto.randomUUID(),
      }),
    ).rejects.toThrow(/Unauthorized/);
    const lease = crypto.randomUUID();
    const claimed = await claim(ctx, lease);
    expect(claimed).toMatchObject({
      status: "claimed",
      notice: { reference: REFERENCE, userId: USER, attempt: 1 },
    });
    // Leased: no second dispatcher can claim it.
    await expect(claim(ctx)).resolves.toEqual({ status: "empty" });
    const id = claimed.notice.noticeId;
    await expect(ack(ctx, id, crypto.randomUUID(), "sent")).resolves.toEqual({
      outcome: "stale",
      status: "other",
    });
    await expect(ack(ctx, id, lease, "sent")).resolves.toEqual({
      outcome: "recorded",
      status: "sent",
    });
    await expect(ack(ctx, id, lease, "not_sent")).resolves.toMatchObject({
      outcome: "stale",
      status: "sent",
    });
    await expect(claim(ctx)).resolves.toEqual({ status: "empty" });
  });

  it("never resends after an uncertain or expired send", async () => {
    const ctx = await blocked();
    const lease = crypto.randomUUID();
    const { notice } = await claim(ctx, lease);
    const row = ctx.tables.abuse_block_notices[0];
    row.leaseExpiresAt = Date.now() - 1;
    // Expiry turns the lease into an uncertain send that is never re-claimed.
    await expect(claim(ctx)).resolves.toEqual({ status: "empty" });
    expect(row.status).toBe("uncertain");
    // A stale non-acceptance result cannot make it sendable again.
    await expect(ack(ctx, notice.noticeId, lease, "not_sent")).resolves.toEqual(
      { outcome: "stale", status: "uncertain" },
    );
    await expect(claim(ctx)).resolves.toEqual({ status: "empty" });
    // A late acceptance from the same lease is the truth and is recorded.
    await expect(ack(ctx, notice.noticeId, lease, "sent")).resolves.toEqual({
      outcome: "recorded",
      status: "sent",
    });
  });

  it("retries only definite non-sends, with backoff and a bounded budget", async () => {
    const ctx = await blocked();
    const row = ctx.tables.abuse_block_notices[0];
    for (let attempt = 1; attempt <= 5; attempt++) {
      row.nextAttemptAt = 0;
      const lease = crypto.randomUUID();
      const { notice } = await claim(ctx, lease);
      expect(notice.attempt).toBe(attempt);
      await ack(ctx, notice.noticeId, lease, "not_sent");
      if (attempt < 5) {
        expect(row.status).toBe("pending");
        expect(row.nextAttemptAt).toBeGreaterThan(Date.now());
        await expect(claim(ctx)).resolves.toEqual({ status: "empty" });
      }
    }
    expect(row).toMatchObject({
      status: "failed",
      failure: "attempts_exhausted",
    });
  });

  it("recovers an expired send while dispatch is paused and rejects a live lease", async () => {
    const ctx = await blocked();
    const { notice } = await claim(ctx);
    process.env.ABUSE_BLOCK_NOTICE_DISPATCH_ENABLED = "false";
    const resolve = () =>
      call(notices, "resolveNotice", ctx, {
        noticeId: notice.noticeId,
        expectedStatus: "sending",
        expectedAttempts: 1,
        resolution: "confirmed_sent",
      });
    await expect(resolve()).rejects.toThrow(/live lease/);
    await ctx.db.patch(notice.noticeId, { leaseExpiresAt: Date.now() - 1 });
    await expect(resolve()).resolves.toEqual({ status: "sent" });
    const row = await ctx.db.get(notice.noticeId);
    expect(row.leaseToken).toBeUndefined();
    expect(row.leaseExpiresAt).toBeUndefined();
    expect((await summary(ctx)).notices.confirmedSentInBlockWindow).toBe(1);
  });

  it("reports incomplete actions when the pending-enforcement scan reaches its budget", async () => {
    const ctx = database();
    const now = Date.now();
    for (let i = 0; i < 201; i++) {
      await ctx.db.insert("egress_review_receipts", {
        decision: "enforcement_pending",
        reason: "enforcement_disabled",
        coverage: "complete",
        createdAt: now,
      });
    }
    await expect(summary(ctx)).resolves.toMatchObject({
      actions: [],
      actionsTruncated: true,
    });
  });

  it("reports a disabled runner's backlog as actions without account data", async () => {
    const ctx = await blocked();
    process.env.ABUSE_BLOCK_NOTICE_DISPATCH_ENABLED = "false";
    await expect(claim(ctx)).resolves.toEqual({ status: "disabled" });
    const report = await summary(ctx);
    expect(report.switches).toEqual({
      review: true,
      enforcement: true,
      dispatch: false,
    });
    expect(report.notices.pending).toEqual({ count: 1, truncated: false });
    expect(report.blocks).toMatchObject({ active: 1, lifted: 0 });
    expect(report.reviews.decisions.block_applied).toBe(1);
    expect(report.actions).toEqual(
      expect.arrayContaining([
        { reference: REFERENCE, action: "notice_backlog" },
        { reference: REFERENCE, action: "review_block" },
      ]),
    );
    const text = JSON.stringify(report);
    for (const raw of [USER, CHAT, RUN, "synthetic request"])
      expect(text).not.toContain(raw);
  });

  it("lists uncertain and failed notices until an operator reconciles them", async () => {
    const ctx = await blocked();
    const lease = crypto.randomUUID();
    const { notice } = await claim(ctx, lease);
    await ack(ctx, notice.noticeId, lease, "uncertain");
    expect((await summary(ctx)).actions).toContainEqual({
      reference: REFERENCE,
      action: "reconcile_uncertain_notice",
    });
    const resolve = (resolution: string, expectedStatus = "uncertain") =>
      call(notices, "resolveNotice", ctx, {
        noticeId: notice.noticeId,
        expectedStatus,
        expectedAttempts: 1,
        resolution,
      });
    await expect(resolve("retry")).rejects.toThrow(/Reconcile/);
    await expect(resolve("confirmed_sent")).resolves.toEqual({
      status: "sent",
    });
    expect(
      (await summary(ctx)).actions.map(({ action }: any) => action),
    ).not.toContain("reconcile_uncertain_notice");
  });

  it("queues one notice per account while an earlier block is still active", async () => {
    const ctx = await blocked();
    // A second automated case for the same account (its containment owner
    // cleared, as after a manual handoff) must not email the account again.
    ctx.tables.abuse_cases[0].activeContainmentUserId = undefined;
    const second = "AB-0123abcd-0123-4abc-8abc-0123456789ac";
    await expect(
      apply(ctx, { reference: second, digest: "e".repeat(64) }),
    ).resolves.toMatchObject({ outcome: "applied", notice: "deduplicated" });
    expect(
      ctx.tables.abuse_block_notices.map(({ status }: any) => status),
    ).toEqual(["pending", "deduplicated"]);
  });
});

describe("review receipts", () => {
  it("keeps references only on pending-enforcement actions", async () => {
    const ctx = database();
    const receipt = (overrides: Record<string, unknown>) =>
      call(review, "recordReceipt", ctx, {
        serviceKey: REVIEW_KEY,
        digest: DIGEST,
        decision: "keep_active",
        reason: "inconclusive",
        reviewReason: "ambiguous",
        evidenceMode: "exact_run",
        coverage: "complete",
        caseOutcome: "created",
        ...overrides,
      });
    await expect(receipt({ reference: REFERENCE })).rejects.toThrow(
      "Invalid review receipt",
    );
    await expect(
      receipt({
        decision: "block_applied",
        reason: "harmful_intent_confirmed",
      }),
    ).rejects.toThrow("Invalid review receipt");
    await expect(receipt({})).resolves.toEqual({ outcome: "created" });
    // First decision of the window wins, like its case.
    await expect(
      receipt({ decision: "enforcement_pending", reference: REFERENCE }),
    ).resolves.toEqual({ outcome: "existing" });
    expect(ctx.tables.egress_review_receipts).toHaveLength(1);
    expect(ctx.tables.egress_review_receipts[0].reference).toBeUndefined();
  });
});
