import { ConvexError, v } from "convex/values";
import { verifyServiceArgs } from "../lib/db/service-proof";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation } from "./lib/serviceFunctions";
import {
  boundedAbuseCiphertext,
  computeResponsePlan,
  invalidateLocalAccess,
} from "./lib/abuseResponse";
import { blockableIntent, blockRefusal } from "./lib/abuseValidators";
import { insertReceipt } from "./lib/egressReceipts";
import { collectRunEvidence, ownedChat } from "./egressAbuseReview";
import {
  BLOCK_NOTICE_TEMPLATE_VERSION,
  ENFORCEMENT_ACTOR,
  ENFORCEMENT_POLICY_VERSION,
  VERIFIED_EGRESS_BLOCK_SCOPE,
  egressEvidenceFingerprint,
  type BlockRefusal,
} from "../lib/abuse/egress-outcomes";

// The only automated path that restricts an account. Authorized by its own
// key and its own switch, independent of the read-only review. One
// transaction creates the review case, the case-owned `security_abuse`
// restriction, local-access revocation, the reviewed-response receipt that
// operators resolve through the existing case flow, and the notice outbox
// row. It never cancels runs or contacts a sandbox: work already running is
// left for an operator and is never reported as stopped.

const REVIEW_ACTOR = "egress_abuse_review";
const REFERENCE =
  /^AB-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const RUN_ID = /^run_[a-zA-Z0-9]{1,64}$/;
const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,160}$/;
const MAX_CITATIONS = 10;
const MAX_BURST_SPAN_MS = 10 * 60_000;
/** A block decides on a recent burst only, never a retroactive window. */
const MAX_BLOCK_BURST_AGE_MS = 24 * 60 * 60_000;
const CLOCK_SKEW_MS = 60_000;
/** The date by which an operator should have reviewed the automated block. */
const REVIEW_DUE_DAYS = 30;
const DAY_MS = 24 * 60 * 60_000;
/** Notices that still represent this account's current block. */
const LIVE_NOTICE = ["pending", "sending", "sent", "uncertain"] as const;

/** Exactly "true"; the review switch must also be on. */
export function enforcementEnabled(env = process.env) {
  return (
    env.E2B_EGRESS_ABUSE_REVIEW_ENABLED === "true" &&
    env.E2B_EGRESS_ABUSE_ENFORCEMENT_ENABLED === "true"
  );
}

function authorize(serviceKey: string) {
  const expected = process.env.CONVEX_EGRESS_ABUSE_ENFORCEMENT_SERVICE_KEY;
  if (
    !expected ||
    serviceKey !== expected ||
    [
      process.env.CONVEX_SERVICE_ROLE_KEY,
      process.env.CONVEX_USER_RESEARCH_SERVICE_KEY,
      process.env.CONVEX_EGRESS_ABUSE_REVIEW_SERVICE_KEY,
      process.env.CONVEX_ABUSE_NOTICE_DISPATCH_SERVICE_KEY,
    ].includes(expected)
  )
    throw new Error("Unauthorized: Invalid egress abuse enforcement key");
}

async function sha256(text: string) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/** Stable across every send attempt and reconciliation of one notice. */
export async function blockNoticeMessageId(reference: string) {
  const hex = await sha256(`block-notice\n${reference}`);
  return `<abuse-block.${hex.slice(0, 40)}@hackerai.co>`;
}

/** Deterministic UUID-shaped request ID of the automated response row. */
export async function automatedRequestId(reference: string) {
  const hex = await sha256(`automated-request\n${reference}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const PLAN_REFUSALS: Record<string, BlockRefusal> = {
  ABUSE_COMPETING_CASE: "competing_case",
  ABUSE_RESTRICTION_CONFLICT: "restriction_conflict",
  ABUSE_SCOPE_MISMATCH: "account_unavailable",
  ABUSE_INVALID_INPUT: "run_unverified",
};

const appliedResult = v.object({
  outcome: v.literal("applied"),
  restriction: v.union(v.literal("created"), v.literal("adopted")),
  notice: v.union(v.literal("queued"), v.literal("deduplicated")),
});

/**
 * Applies one automated block for a confirmed exact-run decision. It creates
 * the case itself and refuses every existing case, so it can never act on a
 * window that an earlier review or an operator already recorded, resolved or
 * erased. A retry after a lost response returns `existing_block`.
 */
export const applyBlock = mutation({
  args: {
    serviceKey: v.string(),
    reference: v.string(),
    digest: v.string(),
    ciphertext: v.string(),
    userId: v.string(),
    chatId: v.string(),
    runId: v.string(),
    burstStart: v.number(),
    burstEnd: v.number(),
    policyVersion: v.string(),
    evidenceFingerprint: v.string(),
    reviewProof: v.string(),
    intentKind: blockableIntent,
    messageIds: v.array(v.string()),
    commands: v.array(
      v.object({ messageId: v.string(), toolCallId: v.string() }),
    ),
  },
  returns: v.union(
    appliedResult,
    v.object({ outcome: v.literal("existing_block") }),
    v.object({ outcome: v.literal("refused"), refusal: blockRefusal }),
  ),
  handler: async (ctx, args) => {
    authorize(args.serviceKey);
    if (
      !REFERENCE.test(args.reference) ||
      !DIGEST.test(args.digest) ||
      !DIGEST.test(args.evidenceFingerprint) ||
      args.policyVersion !== ENFORCEMENT_POLICY_VERSION ||
      !IDENTIFIER.test(args.userId) ||
      !IDENTIFIER.test(args.chatId) ||
      !RUN_ID.test(args.runId) ||
      !Number.isSafeInteger(args.burstStart) ||
      !Number.isSafeInteger(args.burstEnd) ||
      args.burstEnd <= args.burstStart ||
      args.burstEnd - args.burstStart > MAX_BURST_SPAN_MS ||
      args.messageIds.length < 1 ||
      args.messageIds.length > MAX_CITATIONS ||
      args.commands.length < 1 ||
      args.commands.length > MAX_CITATIONS ||
      ![
        ...args.messageIds,
        ...args.commands.flatMap((c) => [c.messageId, c.toolCallId]),
      ].every((id) => IDENTIFIER.test(id))
    )
      throw new Error("Invalid enforcement request");
    boundedAbuseCiphertext(args.ciphertext, true);
    const refused = (refusal: BlockRefusal) => ({
      outcome: "refused" as const,
      refusal,
    });
    // The kill switch: an authenticated worker learns it at once and records
    // pending enforcement instead of retrying.
    if (!enforcementEnabled()) return refused("enforcement_disabled");

    const { serviceKey: _enforcementKey, reviewProof, ...inputs } = args;
    const deployment = process.env.CONVEX_CLOUD_URL;
    if (
      !deployment ||
      !(await verifyServiceArgs(
        { deployment, name: VERIFIED_EGRESS_BLOCK_SCOPE, type: "mutation" },
        { ...inputs, serviceKey: reviewProof },
        process.env.CONVEX_EGRESS_ABUSE_REVIEW_SERVICE_KEY,
      ))
    )
      return refused("evidence_mismatch");

    const requestId = await automatedRequestId(args.reference);
    const existing = await ctx.db
      .query("abuse_cases")
      .withIndex("by_reference", (q) => q.eq("reference", args.reference))
      .unique();
    if (existing) {
      const response = await ctx.db
        .query("abuse_responses")
        .withIndex("by_caseId", (q) => q.eq("caseId", existing._id))
        .unique();
      return response?.actor === ENFORCEMENT_ACTOR &&
        response.requestId === requestId &&
        response.userId === args.userId &&
        response.chatId === args.chatId &&
        response.runId === args.runId &&
        existing.status !== "resolved" &&
        (await ctx.db.get(response.suspensionId))?.status === "active"
        ? { outcome: "existing_block" as const }
        : refused("case_exists");
    }
    const now = Date.now();
    if (
      args.burstEnd > now + CLOCK_SKEW_MS ||
      args.burstStart < now - MAX_BLOCK_BURST_AGE_MS
    )
      return refused("stale_burst");
    const chat = await ownedChat(ctx, args.userId, args.chatId);
    if (!chat) return refused("account_unavailable");
    if (chat.active_trigger_run_id === args.runId) return refused("run_active");
    const evidence = await collectRunEvidence(ctx, args);
    if (evidence.status !== "ok")
      return refused(
        evidence.reason === "subagent_overlap" ||
          evidence.reason === "concurrent_run"
          ? "run_active"
          : "run_unverified",
      );
    const coverage = evidence.coverage;
    if (
      evidence.runEnd === null ||
      coverage.runActive ||
      coverage.historyTruncated ||
      coverage.userMessagesOmitted ||
      coverage.commandsOmitted ||
      coverage.incompleteToolCalls ||
      (await egressEvidenceFingerprint(evidence)) !== args.evidenceFingerprint
    )
      return refused("evidence_mismatch");
    const users = new Set(
      evidence.userMessages
        .filter(({ observedAt }) => observedAt < evidence.runStart)
        .map(({ messageId }) => messageId),
    );
    if (
      !args.messageIds.every((id) => users.has(id)) ||
      !args.commands.every(({ messageId, toolCallId }) =>
        evidence.commands.some(
          (call) =>
            call.messageId === messageId && call.toolCallId === toolCallId,
        ),
      )
    )
      return refused("evidence_mismatch");

    // The existing late-report plan checks the account owns the chat, that
    // no other case owns containment for it, and how to adopt a restriction.
    const draft = {
      _id: "" as Id<"abuse_cases">,
      _creationTime: now,
      reference: args.reference,
      digest: args.digest,
      kind: "abuse",
      ciphertext: args.ciphertext,
      status: "new",
      revision: 0,
      evidenceHold: true,
      createdAt: now,
      updatedAt: now,
    } satisfies Doc<"abuse_cases">;
    let planned: Awaited<ReturnType<typeof computeResponsePlan>>;
    try {
      planned = await computeResponsePlan(ctx, draft, {
        userId: args.userId,
        chatId: args.chatId,
        runId: args.runId,
        transport: "cloud",
      });
    } catch (error) {
      const code =
        error instanceof ConvexError &&
        typeof (error.data as { code?: unknown })?.code === "string"
          ? PLAN_REFUSALS[(error.data as { code: string }).code]
          : undefined;
      if (code) return refused(code);
      throw error;
    }

    // Every check passed; nothing above wrote. All writes below commit
    // together or not at all.
    const caseId = await ctx.db.insert("abuse_cases", {
      reference: args.reference,
      digest: args.digest,
      kind: "abuse",
      ciphertext: args.ciphertext,
      status: "needs_followup",
      revision: 1,
      evidenceHold: true,
      activeContainmentUserId: args.userId,
      createdAt: now,
      updatedAt: now,
    });
    for (const [actor, kind] of [
      [REVIEW_ACTOR, "received"],
      [ENFORCEMENT_ACTOR, "decision"],
      [ENFORCEMENT_ACTOR, "containment_started"],
    ] as const)
      await ctx.db.insert("abuse_events", {
        caseId,
        actor,
        kind,
        createdAt: now,
      });
    const suspensionId =
      planned.existing?._id ??
      (await ctx.db.insert("user_suspensions", {
        user_id: args.userId,
        status: "active",
        category: "security_abuse",
        source: "support",
        source_id: planned.sourceId,
        source_reason: "automated_egress_abuse_block",
        created_at: now,
        updated_at: now,
        source_created_at: now,
      }));
    const local = await invalidateLocalAccess(
      ctx,
      args.userId,
      planned.sourceId,
      now,
    );
    // No lease: an operator resumes discovery and cancellation of active work
    // through the existing `retry` flow, and resolves through the case.
    await ctx.db.insert("abuse_responses", {
      caseId,
      requestId,
      requestDigest: args.digest,
      planDigest: planned.digest,
      actor: ENFORCEMENT_ACTOR,
      reviewer: ENFORCEMENT_ACTOR,
      reviewDate: utcDate(now),
      retentionReviewDate: utcDate(now + REVIEW_DUE_DAYS * DAY_MS),
      userId: args.userId,
      chatId: args.chatId,
      runId: args.runId,
      transport: "cloud",
      sourceId: planned.sourceId,
      suspensionId,
      restriction: planned.existing ? "adopted" : "created",
      localToken: local.token,
      connectionsDisconnected: local.disconnected,
      connectionsRemaining: local.remaining,
      discoveryPhase: "roots",
      targetOverflow: false,
      targets: [],
      appliedAt: now,
      updatedAt: now,
    });

    // One notice per account's current block.
    let duplicate = false;
    for (const status of LIVE_NOTICE) {
      const notices = await ctx.db
        .query("abuse_block_notices")
        .withIndex("by_userId_and_status", (q) =>
          q.eq("userId", args.userId).eq("status", status),
        )
        .take(10);
      for (const notice of notices) {
        const restriction = await ctx.db.get(notice.suspensionId);
        if (restriction?.status === "active") duplicate = true;
      }
    }
    await ctx.db.insert("abuse_block_notices", {
      caseId,
      reference: args.reference,
      userId: args.userId,
      suspensionId,
      blockRevision: 1,
      templateVersion: BLOCK_NOTICE_TEMPLATE_VERSION,
      messageId: await blockNoticeMessageId(args.reference),
      status: duplicate ? "deduplicated" : "pending",
      attempts: 0,
      nextAttemptAt: now,
      blockedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await insertReceipt(
      ctx,
      {
        digest: args.digest,
        reference: args.reference,
        decision: "block_applied",
        reason: "harmful_intent_confirmed",
        reviewReason: "concerning_unauthorized",
        evidenceMode: "exact_run",
        coverage: "complete",
        caseOutcome: "created",
        intentKind: args.intentKind,
      },
      now,
    );
    return {
      outcome: "applied" as const,
      restriction: planned.existing
        ? ("adopted" as const)
        : ("created" as const),
      notice: duplicate ? ("deduplicated" as const) : ("queued" as const),
    };
  },
});
