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
    if (
      !report ||
      !report.ciphertext ||
      process.env.ABUSE_NOTIFICATIONS_ENABLED !== "true"
    ) {
      await ctx.db.patch(notificationId, {
        status: "failed",
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
