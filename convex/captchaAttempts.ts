import { v } from "convex/values";
import { mutation, internalMutation } from "./lib/serviceFunctions";
import { internal } from "./_generated/api";
import { validateServiceKey } from "./lib/utils";
import { captchaKind } from "./captchaValidators";
import { isUserDeletionFenced } from "./lib/userDeletionFence";

const scope = { serviceKey: v.string(), userId: v.string(), runId: v.string() };
const validCost = (cost: number) =>
  Number.isFinite(cost) && cost >= 0 && cost <= 1;
const dailyLimit = (value: string | undefined, fallback: number) =>
  value === undefined
    ? fallback
    : /^\d{1,5}$/.test(value)
      ? Math.min(Number(value), 10000)
      : 0;

/** The transaction admits exactly one request per run and consumes daily limits
 * even if createTask's outcome is unknown. Never retry a lost admission response.
 */
export const reserve = mutation({
  args: { ...scope, chatId: v.string(), kind: captchaKind },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    if (await isUserDeletionFenced(ctx.db, args.userId)) return false;
    if (
      process.env.HACKERAI_CAPTCHA_JOURNAL_ENABLED !== "1" ||
      !process.env.TWOCAPTCHA_API_KEY
    )
      return false;
    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chat_id", (q) => q.eq("id", args.chatId))
      .first();
    if (
      !chat ||
      chat.user_id !== args.userId ||
      chat.deletion_started_at ||
      chat.active_trigger_run_id !== args.runId
    )
      return false;
    const previous = await ctx.db
      .query("captcha_attempts")
      .withIndex("by_run_id", (q) => q.eq("run_id", args.runId))
      .first();
    if (previous) return false;
    const day = new Date().toISOString().slice(0, 10);
    const limits = [
      {
        bucket: "global",
        limit: dailyLimit(process.env.CAPTCHA_SOLVER_DAILY_ATTEMPTS, 100),
      },
      {
        bucket: `user:${args.userId}`,
        limit: dailyLimit(process.env.CAPTCHA_SOLVER_USER_DAILY_ATTEMPTS, 10),
      },
    ];
    const buckets = await Promise.all(
      limits.map(async (limit) => ({
        ...limit,
        row: await ctx.db
          .query("captcha_daily_limits")
          .withIndex("by_bucket_and_day", (q) =>
            q.eq("bucket", limit.bucket).eq("day", day),
          )
          .first(),
      })),
    );
    if (buckets.some(({ row, limit }) => (row?.attempts ?? 0) >= limit))
      return false;
    for (const { row, bucket } of buckets) {
      if (row) await ctx.db.patch(row._id, { attempts: row.attempts + 1 });
      else
        await ctx.db.insert("captcha_daily_limits", {
          bucket,
          day,
          attempts: 1,
        });
    }
    const now = Date.now();
    const id = await ctx.db.insert("captcha_attempts", {
      user_id: args.userId,
      chat_id: args.chatId,
      run_id: args.runId,
      kind: args.kind,
      state: "creating",
      created_at: now,
      updated_at: now,
      reconciliation_polls: 0,
    });
    // Scheduled atomically before paid creation, including when its response or
    // the worker is lost. This job never creates a provider task or charges users.
    await ctx.scheduler.runAfter(
      30_000,
      internal.captchaReconciliation.reconcile,
      { id },
    );
    return true;
  },
});

export const registerTask = mutation({
  args: { ...scope, taskId: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    if (!Number.isSafeInteger(args.taskId) || args.taskId <= 0)
      throw new Error("Invalid task identity.");
    const row = await ctx.db
      .query("captcha_attempts")
      .withIndex("by_run_id", (q) => q.eq("run_id", args.runId))
      .first();
    if (
      !row ||
      row.user_id !== args.userId ||
      (row.task_id !== undefined && row.task_id !== args.taskId)
    )
      throw new Error("CAPTCHA attempt identity mismatch.");
    if (row.state === "creating")
      await ctx.db.patch(row._id, {
        task_id: args.taskId,
        state: "processing",
        updated_at: Date.now(),
      });
    else if (row.task_id !== args.taskId)
      throw new Error("CAPTCHA attempt has ended.");
    return null;
  },
});

export const recordCost = mutation({
  args: { ...scope, taskId: v.number(), costDollars: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    if (!validCost(args.costDollars)) throw new Error("Invalid provider cost.");
    const row = await ctx.db
      .query("captcha_attempts")
      .withIndex("by_run_id", (q) => q.eq("run_id", args.runId))
      .first();
    if (!row || row.user_id !== args.userId || row.task_id !== args.taskId)
      throw new Error("CAPTCHA attempt identity mismatch.");
    if (row.cost_dollars !== undefined && row.cost_dollars !== args.costDollars)
      throw new Error("Conflicting provider cost.");
    await ctx.db.patch(row._id, {
      state: "ready",
      cost_dollars: args.costDollars,
      updated_at: Date.now(),
    });
    return null;
  },
});

/** Schedule the next watchdog before external I/O, so an action crash cannot
 * drop the chain. A terminal result makes that queued watchdog a no-op.
 */
export const beginReconciliation = internalMutation({
  args: { id: v.id("captcha_attempts") },
  returns: v.union(
    v.object({ taskId: v.union(v.number(), v.null()) }),
    v.null(),
  ),
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id);
    if (!row || ["ready", "unsolvable", "unknown"].includes(row.state))
      return null;
    if (
      row.reconciliation_polls >= 20 ||
      Date.now() - row.created_at >= 15 * 60_000
    ) {
      await ctx.db.patch(id, { state: "unknown", updated_at: Date.now() });
      return null;
    }
    await ctx.db.patch(id, {
      reconciliation_polls: row.reconciliation_polls + 1,
    });
    await ctx.scheduler.runAfter(
      30_000,
      internal.captchaReconciliation.reconcile,
      { id },
    );
    return { taskId: row.task_id ?? null };
  },
});

export const settleReconciliation = internalMutation({
  args: {
    id: v.id("captcha_attempts"),
    taskId: v.number(),
    costDollars: v.optional(v.number()),
    unsolvable: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (
      !row ||
      row.task_id !== args.taskId ||
      row.state === "ready" ||
      row.state === "unsolvable"
    )
      return null;
    if (args.costDollars !== undefined && validCost(args.costDollars))
      await ctx.db.patch(row._id, {
        state: "ready",
        cost_dollars: args.costDollars,
        updated_at: Date.now(),
      });
    else if (args.unsolvable)
      await ctx.db.patch(row._id, {
        state: "unsolvable",
        cost_dollars: 0,
        updated_at: Date.now(),
      });
    return null;
  },
});
