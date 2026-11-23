import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./lib/serviceFunctions";
import { blockNoticeFailure, noticeResult } from "./lib/abuseValidators";
import { lateRestrictionSource } from "./lib/abuseResponse";
import { enforcementEnabled } from "./egressAbuseEnforcement";
import {
  ENFORCEMENT_REASONS,
  REVIEW_COVERAGE,
  type EnforcementDecision,
} from "../lib/abuse/egress-outcomes";

// Pull/ack outbox for automated block notices. A local dispatcher with its
// own narrowly scoped key claims one notice at a time under a lease, resolves
// the exact account's verified address itself, sends through its local mail
// helper, and acknowledges the result. Nothing here stores or returns an
// address. A notice is claimed only while its block is verified active, and a
// possibly accepted message is never resent without operator reconciliation.

const LEASE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 2 * 60_000;
const CLAIM_SCAN = 10;
const SUMMARY_SCAN = 200;
const MAX_ACTIONS = 50;
/** A pending notice older than this is reported as an actionable backlog. */
const BACKLOG_MS = 30 * 60_000;
const HOUR_MS = 60 * 60_000;
const REVIEW_WINDOW_MS = 24 * HOUR_MS;
const BLOCK_WINDOW_MS = 30 * 24 * HOUR_MS;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const dispatchEnabled = (env = process.env) =>
  env.ABUSE_BLOCK_NOTICE_DISPATCH_ENABLED === "true";

function authorize(serviceKey: string) {
  const expected = process.env.CONVEX_ABUSE_NOTICE_DISPATCH_SERVICE_KEY;
  if (
    !expected ||
    serviceKey !== expected ||
    [
      process.env.CONVEX_SERVICE_ROLE_KEY,
      process.env.CONVEX_USER_RESEARCH_SERVICE_KEY,
      process.env.CONVEX_EGRESS_ABUSE_REVIEW_SERVICE_KEY,
      process.env.CONVEX_EGRESS_ABUSE_ENFORCEMENT_SERVICE_KEY,
    ].includes(expected)
  )
    throw new Error("Unauthorized: Invalid abuse notice dispatcher key");
}

/** The notice's own case-owned restriction is active and its case is open. */
async function blockActive(
  ctx: QueryCtx | MutationCtx,
  notice: Doc<"abuse_block_notices">,
) {
  const [restriction, row] = await Promise.all([
    ctx.db.get(notice.suspensionId),
    ctx.db.get(notice.caseId),
  ]);
  return (
    restriction?.status === "active" &&
    restriction.user_id === notice.userId &&
    restriction.category === "security_abuse" &&
    restriction.source === "support" &&
    restriction.source_id === lateRestrictionSource(notice.reference) &&
    row?.reference === notice.reference &&
    row.status !== "resolved"
  );
}

/** An expired send lease may have been accepted: never resend it. */
async function expireLeases(ctx: MutationCtx, now: number) {
  const sending = await ctx.db
    .query("abuse_block_notices")
    .withIndex("by_status_and_nextAttemptAt", (q) => q.eq("status", "sending"))
    .take(CLAIM_SCAN);
  for (const notice of sending)
    if ((notice.leaseExpiresAt ?? 0) <= now)
      await ctx.db.patch(notice._id, { status: "uncertain", updatedAt: now });
}

const claimedNotice = v.object({
  noticeId: v.id("abuse_block_notices"),
  reference: v.string(),
  userId: v.string(),
  messageId: v.string(),
  templateVersion: v.string(),
  blockedAt: v.number(),
  attempt: v.number(),
  leaseExpiresAt: v.number(),
});

/**
 * Claims the oldest due notice whose block is verified active. A notice whose
 * block was lifted before any send is cancelled instead.
 */
export const claim = mutation({
  args: { serviceKey: v.string(), leaseToken: v.string() },
  returns: v.union(
    v.object({ status: v.literal("disabled") }),
    v.object({ status: v.literal("empty") }),
    v.object({ status: v.literal("claimed"), notice: claimedNotice }),
  ),
  handler: async (ctx, args) => {
    authorize(args.serviceKey);
    if (!UUID.test(args.leaseToken)) throw new Error("Invalid lease token");
    if (!dispatchEnabled()) return { status: "disabled" as const };
    const now = Date.now();
    await expireLeases(ctx, now);
    const due = await ctx.db
      .query("abuse_block_notices")
      .withIndex("by_status_and_nextAttemptAt", (q) =>
        q.eq("status", "pending").lte("nextAttemptAt", now),
      )
      .take(CLAIM_SCAN);
    for (const notice of due) {
      if (!(await blockActive(ctx, notice))) {
        await ctx.db.patch(notice._id, {
          status: "cancelled",
          failure: "restriction_inactive",
          updatedAt: now,
        });
        continue;
      }
      const attempt = notice.attempts + 1;
      const leaseExpiresAt = now + LEASE_MS;
      await ctx.db.patch(notice._id, {
        status: "sending",
        attempts: attempt,
        leaseToken: args.leaseToken,
        leaseExpiresAt,
        updatedAt: now,
      });
      return {
        status: "claimed" as const,
        notice: {
          noticeId: notice._id,
          reference: notice.reference,
          userId: notice.userId,
          messageId: notice.messageId,
          templateVersion: notice.templateVersion,
          blockedAt: notice.blockedAt,
          attempt,
          leaseExpiresAt,
        },
      };
    }
    return { status: "empty" as const };
  },
});

/** Confirm the same active restriction after address lookup, before SMTP. */
export const confirmClaim = query({
  args: {
    serviceKey: v.string(),
    noticeId: v.id("abuse_block_notices"),
    leaseToken: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    authorize(args.serviceKey);
    if (!dispatchEnabled()) return false;
    const notice = await ctx.db.get(args.noticeId);
    return Boolean(
      notice?.status === "sending" &&
      notice.leaseToken === args.leaseToken &&
      (notice.leaseExpiresAt ?? 0) > Date.now() &&
      (await blockActive(ctx, notice)),
    );
  },
});

/**
 * Records one send result for the caller's lease. A stale or foreign lease
 * changes nothing, except that a late `sent` from the same expired lease is
 * recorded: an expired lease is never re-claimed, so nothing else sent it.
 */
export const ack = mutation({
  args: {
    serviceKey: v.string(),
    noticeId: v.id("abuse_block_notices"),
    leaseToken: v.string(),
    result: noticeResult,
  },
  returns: v.object({
    outcome: v.union(v.literal("recorded"), v.literal("stale")),
    status: v.union(
      v.literal("pending"),
      v.literal("sent"),
      v.literal("uncertain"),
      v.literal("failed"),
      v.literal("other"),
    ),
  }),
  handler: async (ctx, args) => {
    authorize(args.serviceKey);
    const notice = await ctx.db.get(args.noticeId);
    const now = Date.now();
    const status = (row: Doc<"abuse_block_notices"> | null) =>
      row && ["pending", "sent", "uncertain", "failed"].includes(row.status)
        ? (row.status as "pending" | "sent" | "uncertain" | "failed")
        : ("other" as const);
    if (!notice || notice.leaseToken !== args.leaseToken)
      return { outcome: "stale" as const, status: status(notice) };
    const live =
      notice.status === "sending" && (notice.leaseExpiresAt ?? 0) > now;
    const clear = { leaseToken: undefined, leaseExpiresAt: undefined };
    if (!live) {
      if (
        args.result === "sent" &&
        (notice.status === "sending" || notice.status === "uncertain")
      ) {
        await ctx.db.patch(notice._id, {
          status: "sent",
          sentAt: now,
          updatedAt: now,
          ...clear,
        });
        return { outcome: "recorded" as const, status: "sent" as const };
      }
      if (notice.status === "sending")
        await ctx.db.patch(notice._id, { status: "uncertain", updatedAt: now });
      return {
        outcome: "stale" as const,
        status: status(await ctx.db.get(notice._id)),
      };
    }
    let patch: Partial<Doc<"abuse_block_notices">>;
    switch (args.result) {
      case "sent":
        patch = { status: "sent", sentAt: now };
        break;
      case "not_sent":
        patch =
          notice.attempts >= MAX_ATTEMPTS
            ? { status: "failed", failure: "attempts_exhausted" }
            : {
                status: "pending",
                nextAttemptAt: now + RETRY_BASE_MS * 2 ** (notice.attempts - 1),
              };
        break;
      case "rejected":
        patch = { status: "failed", failure: "rejected" };
        break;
      case "recipient_unavailable":
        patch = { status: "failed", failure: "recipient_unavailable" };
        break;
      case "uncertain":
        patch = { status: "uncertain" };
        break;
    }
    await ctx.db.patch(notice._id, { ...patch, ...clear, updatedAt: now });
    return {
      outcome: "recorded" as const,
      status: status(await ctx.db.get(notice._id)),
    };
  },
});

// --- Owner summary ----------------------------------------------------------

const ACTIONS = [
  "reconcile_uncertain_notice",
  "notice_failed",
  "notice_backlog",
  "review_block",
  "review_pending_enforcement",
] as const;
type Action = { reference: string; action: (typeof ACTIONS)[number] };
const count = v.object({ count: v.number(), truncated: v.boolean() });

/**
 * Aggregate counts and action items. References appear only on actions; no
 * account, chat, run, address or evidence is returned.
 */
export const summary = query({
  args: { serviceKey: v.string() },
  returns: v.object({
    generatedAt: v.number(),
    switches: v.object({
      review: v.boolean(),
      enforcement: v.boolean(),
      dispatch: v.boolean(),
    }),
    reviews: v.object({
      windowHours: v.number(),
      total: v.number(),
      truncated: v.boolean(),
      decisions: v.record(v.string(), v.number()),
      reasons: v.record(v.string(), v.number()),
      coverage: v.record(v.string(), v.number()),
    }),
    blocks: v.object({
      windowDays: v.number(),
      active: v.number(),
      lifted: v.number(),
      truncated: v.boolean(),
    }),
    notices: v.object({
      pending: count,
      sending: count,
      uncertain: count,
      failed: count,
      confirmedSentInBlockWindow: v.number(),
      oldestPendingMinutes: v.union(v.number(), v.null()),
    }),
    actions: v.array(
      v.object({
        reference: v.string(),
        action: v.union(...ACTIONS.map((action) => v.literal(action))),
        failure: v.optional(blockNoticeFailure),
      }),
    ),
    actionsTruncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    authorize(args.serviceKey);
    const now = Date.now();
    const actions: (Action & {
      failure?: Doc<"abuse_block_notices">["failure"];
    })[] = [];
    const act = (item: (typeof actions)[number]) => {
      if (
        !actions.some(
          (known) =>
            known.reference === item.reference && known.action === item.action,
        )
      )
        actions.push(item);
    };

    const receipts = await ctx.db
      .query("egress_review_receipts")
      .withIndex("by_createdAt", (q) =>
        q.gte("createdAt", now - REVIEW_WINDOW_MS),
      )
      .take(SUMMARY_SCAN * 5 + 1);
    const tally = (keys: readonly string[]) =>
      Object.fromEntries(keys.map((key) => [key, 0])) as Record<string, number>;
    const decisions = tally([
      "keep_active",
      "block_applied",
      "enforcement_pending",
    ] satisfies EnforcementDecision[]);
    const reasons = tally(ENFORCEMENT_REASONS);
    const coverage = tally(REVIEW_COVERAGE);
    const counted = receipts.slice(0, SUMMARY_SCAN * 5);
    for (const receipt of counted) {
      decisions[receipt.decision]++;
      reasons[receipt.reason]++;
      coverage[receipt.coverage]++;
    }

    const pendingEnforcement = await ctx.db
      .query("egress_review_receipts")
      .withIndex("by_decision_and_createdAt", (q) =>
        q
          .eq("decision", "enforcement_pending")
          .gte("createdAt", now - BLOCK_WINDOW_MS),
      )
      .take(SUMMARY_SCAN);
    for (const receipt of pendingEnforcement) {
      if (!receipt.reference) continue;
      const row = await ctx.db
        .query("abuse_cases")
        .withIndex("by_reference", (q) => q.eq("reference", receipt.reference!))
        .unique();
      // Cleared once an operator records anything on the case or resolves it.
      if (row && row.revision === 0 && row.status !== "resolved")
        act({
          reference: receipt.reference,
          action: "review_pending_enforcement",
        });
    }

    const byStatus = async (
      status: "pending" | "sending" | "uncertain" | "failed",
    ) => {
      const rows = await ctx.db
        .query("abuse_block_notices")
        .withIndex("by_status_and_nextAttemptAt", (q) => q.eq("status", status))
        .take(SUMMARY_SCAN + 1);
      return {
        rows: rows.slice(0, SUMMARY_SCAN),
        truncated: rows.length > SUMMARY_SCAN,
      };
    };
    const pending = await byStatus("pending");
    const sending = await byStatus("sending");
    const uncertain = await byStatus("uncertain");
    const failed = await byStatus("failed");
    const dispatch = dispatchEnabled();
    let oldestPending: number | null = null;
    for (const notice of pending.rows) {
      oldestPending = Math.min(oldestPending ?? Infinity, notice.createdAt);
      if (!dispatch || now - notice.createdAt > BACKLOG_MS)
        act({ reference: notice.reference, action: "notice_backlog" });
    }
    for (const notice of sending.rows)
      if ((notice.leaseExpiresAt ?? 0) <= now)
        act({
          reference: notice.reference,
          action: "reconcile_uncertain_notice",
        });
    for (const notice of uncertain.rows)
      act({
        reference: notice.reference,
        action: "reconcile_uncertain_notice",
      });
    for (const notice of failed.rows)
      act({
        reference: notice.reference,
        action: "notice_failed",
        ...(notice.failure ? { failure: notice.failure } : {}),
      });

    const recent = await ctx.db
      .query("abuse_block_notices")
      .withIndex("by_createdAt", (q) =>
        q.gte("createdAt", now - BLOCK_WINDOW_MS),
      )
      .order("desc")
      .take(SUMMARY_SCAN + 1);
    let active = 0;
    let lifted = 0;
    for (const notice of recent.slice(0, SUMMARY_SCAN)) {
      if (!(await blockActive(ctx, notice))) {
        lifted++;
        continue;
      }
      active++;
      const row = await ctx.db.get(notice.caseId);
      if (row && row.revision <= notice.blockRevision)
        act({ reference: notice.reference, action: "review_block" });
    }

    return {
      generatedAt: now,
      switches: {
        review: process.env.E2B_EGRESS_ABUSE_REVIEW_ENABLED === "true",
        enforcement: enforcementEnabled(),
        dispatch,
      },
      reviews: {
        windowHours: REVIEW_WINDOW_MS / HOUR_MS,
        total: counted.length,
        truncated: receipts.length > counted.length,
        decisions,
        reasons,
        coverage,
      },
      blocks: {
        windowDays: BLOCK_WINDOW_MS / (24 * HOUR_MS),
        active,
        lifted,
        truncated: recent.length > SUMMARY_SCAN,
      },
      notices: {
        pending: { count: pending.rows.length, truncated: pending.truncated },
        sending: { count: sending.rows.length, truncated: sending.truncated },
        uncertain: {
          count: uncertain.rows.length,
          truncated: uncertain.truncated,
        },
        failed: { count: failed.rows.length, truncated: failed.truncated },
        confirmedSentInBlockWindow: recent
          .slice(0, SUMMARY_SCAN)
          .filter((notice) => notice.status === "sent").length,
        oldestPendingMinutes:
          oldestPending === null
            ? null
            : Math.floor((now - oldestPending) / 60_000),
      },
      actions: actions.slice(0, MAX_ACTIONS),
      actionsTruncated: actions.length > MAX_ACTIONS,
    };
  },
});

// --- Operator recovery (internal; run from the authorized dashboard) -------

/**
 * Explicit recovery after checking the abuse@ Sent folder for the notice's
 * stable Message-ID. `confirmed_not_sent` and `retry` queue one more send only
 * while the block is still active; the attempt count is never reset.
 */
export const resolveNotice = internalMutation({
  args: {
    noticeId: v.id("abuse_block_notices"),
    expectedStatus: v.union(v.literal("uncertain"), v.literal("failed")),
    expectedAttempts: v.number(),
    resolution: v.union(
      v.literal("confirmed_sent"),
      v.literal("confirmed_not_sent"),
      v.literal("retry"),
      v.literal("dismiss"),
    ),
  },
  returns: v.object({ status: v.string() }),
  handler: async (ctx, args) => {
    const notice = await ctx.db.get(args.noticeId);
    if (
      !notice ||
      notice.status !== args.expectedStatus ||
      notice.attempts !== args.expectedAttempts
    )
      throw new Error("Notice changed; read it again before recovering");
    const now = Date.now();
    const clear = { leaseToken: undefined, leaseExpiresAt: undefined };
    const requeue = async () => {
      if (!(await blockActive(ctx, notice)))
        throw new Error("The block is no longer active");
      return {
        status: "pending" as const,
        failure: undefined,
        nextAttemptAt: now,
      };
    };
    let patch: Partial<Doc<"abuse_block_notices">>;
    if (args.resolution === "dismiss") patch = { status: "cancelled" };
    else if (notice.status === "uncertain") {
      if (args.resolution === "retry")
        throw new Error("Reconcile an uncertain notice first");
      patch =
        args.resolution === "confirmed_sent"
          ? { status: "sent", sentAt: now }
          : await requeue();
    } else {
      if (args.resolution !== "retry")
        throw new Error("A failed notice can only be retried or dismissed");
      patch = await requeue();
    }
    await ctx.db.patch(notice._id, { ...patch, ...clear, updatedAt: now });
    return { status: patch.status! };
  },
});
