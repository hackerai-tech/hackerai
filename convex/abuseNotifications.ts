import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./lib/serviceFunctions";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { ABUSE_SEND_LEASE_MS } from "./lib/abuseQueue";

type Delivery = Doc<"abuse_notifications">;

async function payload(ctx: MutationCtx, row: Delivery) {
  // Historical case-owned notifications retain their original evidence policy.
  if (row.caseId) {
    const report = await ctx.db.get(row.caseId);
    return report?.ciphertext
      ? {
          reference: report.reference,
          ciphertext: report.ciphertext,
          receivedAt: report.createdAt,
        }
      : null;
  }
  return row.reference &&
    row.ciphertext &&
    row.receivedAt !== undefined &&
    row.payloadExpiresAt !== undefined &&
    row.payloadExpiresAt > Date.now()
    ? {
        reference: row.reference,
        ciphertext: row.ciphertext,
        receivedAt: row.receivedAt,
      }
    : null;
}

export const claim = internalMutation({
  args: { notificationId: v.id("abuse_notifications") },
  returns: v.union(
    v.null(),
    v.object({
      reference: v.string(),
      ciphertext: v.string(),
      receivedAt: v.number(),
      attempt: v.number(),
    }),
  ),
  handler: async (ctx, { notificationId }) => {
    const row = await ctx.db.get(notificationId);
    if (!row || row.status !== "pending") return null;
    if (
      !row.caseId &&
      row.payloadExpiresAt !== undefined &&
      row.payloadExpiresAt <= Date.now()
    ) {
      await ctx.db.patch(notificationId, {
        status: "expired",
        ciphertext: undefined,
        payloadExpiresAt: undefined,
        updatedAt: Date.now(),
      });
      return null;
    }
    const report = await payload(ctx, row);
    if (!report) {
      await ctx.db.patch(notificationId, {
        status: "failed",
        updatedAt: Date.now(),
      });
      return null;
    }
    if (!process.env.ABUSE_SMTP_PASSWORD) {
      await ctx.db.patch(notificationId, {
        status: "paused",
        updatedAt: Date.now(),
      });
      return null;
    }
    const attempt = row.attempts + 1;
    await ctx.db.patch(notificationId, {
      status: "sending",
      attempts: attempt,
      updatedAt: Date.now(),
    });
    // An interrupted send may have transmitted DATA. Never blindly resend it.
    await ctx.scheduler.runAfter(
      ABUSE_SEND_LEASE_MS,
      internal.abuseNotifications.expireClaim,
      { notificationId, attempt },
    );
    return { ...report, attempt };
  },
});

/** Purge temporary data independently of SMTP availability, then recover queued work. */
export const resumePaused = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const expiredPayloads = await ctx.db
      .query("abuse_notifications")
      .withIndex("by_payloadExpiresAt", (q) =>
        q.gt("payloadExpiresAt", 0).lte("payloadExpiresAt", now),
      )
      .take(25);
    for (const row of expiredPayloads) {
      if (row.status === "sending" && row.updatedAt > now - ABUSE_SEND_LEASE_MS)
        continue;
      await ctx.db.patch(row._id, {
        ciphertext: undefined,
        payloadExpiresAt: undefined,
        status:
          row.status === "sending" || row.status === "uncertain"
            ? "uncertain"
            : row.status === "sent"
              ? "sent"
              : "expired",
        updatedAt: now,
      });
    }
    const expiredReceipts = await ctx.db
      .query("abuse_notifications")
      .withIndex("by_expiresAt", (q) =>
        q.gt("expiresAt", 0).lte("expiresAt", now),
      )
      .take(25);
    for (const row of expiredReceipts) {
      if (row.status === "sending" && row.updatedAt > now - ABUSE_SEND_LEASE_MS)
        continue;
      await ctx.db.delete(row._id);
    }
    const limits = await ctx.db
      .query("abuse_rate_limits")
      .withIndex("by_expiresAt", (q) => q.lte("expiresAt", now))
      .take(25);
    for (const row of limits) await ctx.db.delete(row._id);
    if (!process.env.ABUSE_SMTP_PASSWORD) return null;
    const rows = await ctx.db
      .query("abuse_notifications")
      .withIndex("by_status", (q) => q.eq("status", "paused"))
      .take(25);
    for (const row of rows) {
      await ctx.db.patch(row._id, { status: "pending", updatedAt: now });
      await ctx.scheduler.runAfter(
        0,
        internal.abuseNotificationActions.deliver,
        { notificationId: row._id },
      );
    }
    // Recover dropped at-most-once actions without advancing a valid delayed retry.
    const staleBefore = now - (60_000 * 4 ** 3 + 5 * 60_000);
    const pending = await ctx.db
      .query("abuse_notifications")
      .withIndex("by_status_and_updatedAt", (q) =>
        q.eq("status", "pending").lt("updatedAt", staleBefore),
      )
      .take(25);
    for (const row of pending) {
      await ctx.db.patch(row._id, { updatedAt: now });
      await ctx.scheduler.runAfter(
        0,
        internal.abuseNotificationActions.deliver,
        { notificationId: row._id },
      );
    }
    return null;
  },
});

/** Admin-only recovery after repair; expired payloads and ambiguous sends are excluded. */
export const retryFailed = internalMutation({
  args: {
    notificationId: v.id("abuse_notifications"),
    expectedAttempts: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, { notificationId, expectedAttempts }) => {
    const row = await ctx.db.get(notificationId);
    if (!row || row.status !== "failed" || row.attempts !== expectedAttempts)
      throw new Error("Notification changed or is not a confirmed failure");
    if (!process.env.ABUSE_SMTP_PASSWORD || !(await payload(ctx, row)))
      throw new Error("Notification unavailable");
    await ctx.db.patch(notificationId, {
      status: "pending",
      updatedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.abuseNotificationActions.deliver, {
      notificationId,
    });
    return null;
  },
});

/** Reconcile against the mailbox before choosing either decision; this never blindly resends. */
export const reconcileUncertain = internalMutation({
  args: {
    notificationId: v.id("abuse_notifications"),
    expectedAttempts: v.number(),
    decision: v.union(
      v.literal("confirmed_sent"),
      v.literal("confirmed_not_sent"),
    ),
  },
  returns: v.null(),
  handler: async (ctx, { notificationId, expectedAttempts, decision }) => {
    const row = await ctx.db.get(notificationId);
    if (!row || row.status !== "uncertain" || row.attempts !== expectedAttempts)
      throw new Error("Notification changed or is not uncertain");
    if (decision === "confirmed_sent") {
      await ctx.db.patch(notificationId, {
        status: "sent",
        ciphertext: undefined,
        payloadExpiresAt: undefined,
        updatedAt: Date.now(),
      });
    } else {
      if (!process.env.ABUSE_SMTP_PASSWORD || !(await payload(ctx, row)))
        throw new Error("Notification unavailable");
      await ctx.db.patch(notificationId, {
        status: "pending",
        updatedAt: Date.now(),
      });
      await ctx.scheduler.runAfter(
        0,
        internal.abuseNotificationActions.deliver,
        { notificationId },
      );
    }
    return null;
  },
});

export const expireClaim = internalMutation({
  args: { notificationId: v.id("abuse_notifications"), attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, { notificationId, attempt }) => {
    const row = await ctx.db.get(notificationId);
    if (row?.status === "sending" && row.attempts === attempt)
      await ctx.db.patch(notificationId, {
        status: "uncertain",
        updatedAt: Date.now(),
      });
    return null;
  },
});

export const finish = internalMutation({
  args: {
    notificationId: v.id("abuse_notifications"),
    attempt: v.number(),
    outcome: v.union(
      v.literal("sent"),
      v.literal("retry"),
      v.literal("failed"),
      v.literal("uncertain"),
    ),
  },
  returns: v.null(),
  handler: async (ctx, { notificationId, attempt, outcome }) => {
    const row = await ctx.db.get(notificationId);
    if (!row || row.attempts !== attempt || row.status !== "sending")
      return null;
    const expired =
      !row.caseId &&
      row.payloadExpiresAt !== undefined &&
      row.payloadExpiresAt <= Date.now();
    const retry = outcome === "retry" && attempt < 5 && !expired;
    await ctx.db.patch(notificationId, {
      status: retry
        ? "pending"
        : expired && (outcome === "retry" || outcome === "failed")
          ? "expired"
          : outcome === "retry"
            ? "failed"
            : outcome,
      ...(outcome === "sent" || expired
        ? { ciphertext: undefined, payloadExpiresAt: undefined }
        : {}),
      updatedAt: Date.now(),
    });
    if (retry)
      await ctx.scheduler.runAfter(
        60_000 * 4 ** (attempt - 1),
        internal.abuseNotificationActions.deliver,
        { notificationId },
      );
    return null;
  },
});
