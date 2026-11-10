import { v } from "convex/values";
import { internalMutation } from "./lib/serviceFunctions";
import { internal } from "./_generated/api";

export const claim = internalMutation({
  args: { notificationId: v.id("abuse_notifications") },
  returns: v.union(
    v.null(),
    v.object({ reference: v.string(), attempt: v.number() }),
  ),
  handler: async (ctx, { notificationId }) => {
    const row = await ctx.db.get(notificationId);
    if (!row || row.status !== "pending") return null;
    const report = await ctx.db.get(row.caseId);
    if (!report || !report.ciphertext) {
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
    // A crashed action may have transmitted DATA. Never blindly resend it.
    await ctx.scheduler.runAfter(
      120_000,
      internal.abuseNotifications.expireClaim,
      { notificationId, attempt },
    );
    return { reference: report.reference, attempt };
  },
});

export const resumePaused = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    if (!process.env.ABUSE_SMTP_PASSWORD) return null;
    const rows = await ctx.db
      .query("abuse_notifications")
      .withIndex("by_status", (q) => q.eq("status", "paused"))
      .take(25);
    for (const row of rows) {
      await ctx.db.patch(row._id, { status: "pending", updatedAt: Date.now() });
      await ctx.scheduler.runAfter(
        0,
        internal.abuseNotificationActions.deliver,
        { notificationId: row._id },
      );
    }
    // Scheduled actions are at-most-once. Recover a dropped action without
    // advancing any legitimate retry (maximum backoff is 64 minutes).
    const staleBefore = Date.now() - (60_000 * 4 ** 3 + 5 * 60_000);
    const pending = await ctx.db
      .query("abuse_notifications")
      .withIndex("by_status_and_updatedAt", (q) =>
        q.eq("status", "pending").lt("updatedAt", staleBefore),
      )
      .take(25);
    for (const row of pending) {
      await ctx.db.patch(row._id, { updatedAt: Date.now() });
      await ctx.scheduler.runAfter(
        0,
        internal.abuseNotificationActions.deliver,
        { notificationId: row._id },
      );
    }
    return null;
  },
});

/** Admin-only recovery after configuration is corrected; ambiguous sends require reconciliation. */
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
    const report = await ctx.db.get(row.caseId);
    if (!report?.ciphertext || !process.env.ABUSE_SMTP_PASSWORD)
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
    const retry = outcome === "retry" && attempt < 5;
    await ctx.db.patch(notificationId, {
      status: retry ? "pending" : outcome === "retry" ? "failed" : outcome,
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
