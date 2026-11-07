import { ConvexError, v } from "convex/values";
import {
  query,
  mutation,
  type QueryCtx,
  type MutationCtx,
} from "./lib/serviceFunctions";
import type { Doc, Id } from "./_generated/dataModel";
import { validateServiceKey } from "./lib/utils";
import { isUserDeletionFenced } from "./lib/userDeletionFence";
import { assertUserCanAccessChatHistory } from "./lib/suspensionGuards";
import { scheduleDefinition, scheduleRunStatus } from "./scheduleValidators";
import {
  MAX_SCHEDULES,
  nextScheduledTime,
  validateSchedule,
} from "../lib/schedules/recurrence";

const auth = { serviceKey: v.string(), userId: v.string() };
async function authorize(
  ctx: QueryCtx | MutationCtx,
  args: { serviceKey: string; userId: string },
) {
  validateServiceKey(args.serviceKey);
  if (await isUserDeletionFenced(ctx.db, args.userId))
    throw new ConvexError("Account is being deleted.");
  await assertUserCanAccessChatHistory(ctx, args.userId);
}
async function owned(
  ctx: QueryCtx | MutationCtx,
  id: Id<"agent_schedules">,
  userId: string,
) {
  const schedule = await ctx.db.get(id);
  if (!schedule || schedule.user_id !== userId)
    throw new ConvexError("Schedule not found.");
  return schedule;
}
async function runState(
  ctx: QueryCtx | MutationCtx,
  run: Doc<"schedule_runs">,
) {
  const chat = await ctx.db
    .query("chats")
    .withIndex("by_chat_id", (q) => q.eq("id", run.chat_id))
    .unique();
  const hasTask = Boolean(
    chat && chat.user_id === run.user_id && !chat.deletion_started_at,
  );
  if (!run.trigger_run_id) return { status: run.status, hasTask };
  if (!hasTask) return { status: "deleted", hasTask: false };
  if (chat?.active_trigger_run_id === run.trigger_run_id)
    return { status: "running", hasTask };
  if (chat?.canceled_at) return { status: "canceled", hasTask };
  return {
    status: run.status === "started" ? "finishing" : run.status,
    hasTask,
  };
}

export const list = query({
  args: auth,
  // Result status is derived from the normal task's authoritative completion state.
  returns: v.array(
    v.object({
      id: v.id("agent_schedules"),
      definition: scheduleDefinition,
      enabled: v.boolean(),
      consumed: v.boolean(),
      nextRunAt: v.union(v.number(), v.null()),
      runs: v.array(
        v.object({
          id: v.id("schedule_runs"),
          chatId: v.string(),
          hasTask: v.boolean(),
          status: v.string(),
          detail: v.union(v.string(), v.null()),
          createdAt: v.number(),
        }),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    await authorize(ctx, args);
    const rows = await ctx.db
      .query("agent_schedules")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .order("desc")
      .take(MAX_SCHEDULES);
    return Promise.all(
      rows.map(async (s) => ({
        id: s._id,
        definition: s.definition,
        enabled: s.enabled,
        consumed: s.consumed_at !== undefined,
        nextRunAt: s.next_run_at ?? null,
        runs: await Promise.all(
          (
            await ctx.db
              .query("schedule_runs")
              .withIndex("by_schedule_id", (q) => q.eq("schedule_id", s._id))
              .order("desc")
              .take(5)
          ).map(async (r) => ({
            id: r._id,
            chatId: r.chat_id,
            ...(await runState(ctx, r)),
            detail: r.detail ?? null,
            createdAt: r.created_at,
          })),
        ),
      })),
    );
  },
});
export const save = mutation({
  args: {
    ...auth,
    id: v.optional(v.id("agent_schedules")),
    definition: scheduleDefinition,
    organizationId: v.optional(v.string()),
  },
  returns: v.id("agent_schedules"),
  handler: async (ctx, args) => {
    await authorize(ctx, args);
    const definition = validateSchedule(args.definition);
    const now = Date.now();
    const next = nextScheduledTime(definition.timing, now);
    if (next === null) throw new ConvexError("Choose a time in the future.");
    if (args.id) {
      const row = await owned(ctx, args.id, args.userId);
      const sameTiming =
        JSON.stringify(row.definition.timing) ===
        JSON.stringify(definition.timing);
      const rearmed =
        row.consumed_at !== undefined &&
        definition.timing.type === "once" &&
        !sameTiming;
      const enabled = row.enabled || rearmed;
      await ctx.db.patch(row._id, {
        definition,
        organization_id: args.organizationId,
        revision: row.revision + 1,
        enabled,
        consumed_at: rearmed ? undefined : row.consumed_at,
        next_run_at: enabled
          ? sameTiming && row.next_run_at !== undefined
            ? row.next_run_at
            : next
          : undefined,
        updated_at: now,
      });
      return row._id;
    }
    const existing = await ctx.db
      .query("agent_schedules")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .take(MAX_SCHEDULES);
    if (existing.length >= MAX_SCHEDULES)
      throw new ConvexError(`You can have up to ${MAX_SCHEDULES} schedules.`);
    return ctx.db.insert("agent_schedules", {
      user_id: args.userId,
      organization_id: args.organizationId,
      definition,
      enabled: true,
      revision: 1,
      next_run_at: next,
      created_at: now,
      updated_at: now,
    });
  },
});
export const setEnabled = mutation({
  args: { ...auth, id: v.id("agent_schedules"), enabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await authorize(ctx, args);
    const row = await owned(ctx, args.id, args.userId);
    const next = args.enabled
      ? nextScheduledTime(row.definition.timing, Date.now())
      : null;
    if (args.enabled && next === null)
      throw new ConvexError("Edit this schedule to choose a future time.");
    await ctx.db.patch(row._id, {
      enabled: args.enabled,
      revision: row.revision + 1,
      next_run_at: next ?? undefined,
      updated_at: Date.now(),
    });
    return null;
  },
});
export const remove = mutation({
  args: { ...auth, id: v.id("agent_schedules") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await authorize(ctx, args);
    await owned(ctx, args.id, args.userId);
    // At most 200 retained receipts per schedule; result chats remain normal tasks.
    const runs = await ctx.db
      .query("schedule_runs")
      .withIndex("by_schedule_id", (q) => q.eq("schedule_id", args.id))
      .take(201);
    for (const run of runs) await ctx.db.delete(run._id);
    await ctx.db.delete(args.id);
    return null;
  },
});
export const due = query({
  args: { serviceKey: v.string() },
  returns: v.array(
    v.object({
      id: v.id("agent_schedules"),
      revision: v.number(),
      at: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const rows = await ctx.db
      .query("agent_schedules")
      .withIndex("by_enabled_and_next_run_at", (q) =>
        q
          .eq("enabled", true)
          .gt("next_run_at", 0)
          .lte("next_run_at", Date.now()),
      )
      .take(50);
    return rows.map((s) => ({
      id: s._id,
      revision: s.revision,
      at: s.next_run_at!,
    }));
  },
});
export const getForDispatch = query({
  args: { serviceKey: v.string(), id: v.id("agent_schedules") },
  returns: v.union(
    v.null(),
    v.object({
      userId: v.string(),
      organizationId: v.optional(v.string()),
      definition: scheduleDefinition,
      revision: v.number(),
      enabled: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const s = await ctx.db.get(args.id);
    if (!s) return null;
    if (await isUserDeletionFenced(ctx.db, s.user_id)) return null;
    return {
      userId: s.user_id,
      organizationId: s.organization_id,
      definition: s.definition,
      revision: s.revision,
      enabled: s.enabled,
    };
  },
});
export const claim = mutation({
  args: {
    ...auth,
    id: v.id("agent_schedules"),
    revision: v.number(),
    at: v.optional(v.number()),
    manual: v.boolean(),
    queueOnly: v.optional(v.boolean()),
    dispatcherRunId: v.optional(v.string()),
    dispatcherId: v.string(),
    chatId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({ id: v.id("schedule_runs"), chatId: v.string() }),
  ),
  handler: async (ctx, args) => {
    await authorize(ctx, args);
    const s = await owned(ctx, args.id, args.userId);
    const now = Date.now();
    if (s.revision !== args.revision) return null;
    const occurrence = args.manual
      ? `manual:${args.dispatcherId}`
      : `${args.revision}:${args.at}`;
    const existing = await ctx.db
      .query("schedule_runs")
      .withIndex("by_schedule_and_occurrence", (q) =>
        q.eq("schedule_id", s._id).eq("occurrence", occurrence),
      )
      .unique();
    if (existing) {
      if (
        args.queueOnly ||
        existing.dispatcher_id !== args.dispatcherId ||
        !["queued", "starting"].includes(existing.status)
      )
        return null;
      if (existing.status === "queued")
        await ctx.db.patch(existing._id, {
          status: "starting",
          dispatcher_run_id: args.dispatcherRunId,
        });
      return { id: existing._id, chatId: existing.chat_id };
    }
    if (args.queueOnly && !args.manual)
      throw new ConvexError("Only Run now can be queued manually.");
    if (!args.manual && !s.enabled) return null;
    if (
      !args.manual &&
      (args.at === undefined || args.at !== s.next_run_at || args.at > now)
    )
      return null;
    if (args.manual && s.last_manual_at && now - s.last_manual_at < 60000)
      throw new ConvexError(
        "Wait a minute before running this schedule again.",
      );
    const active = s.active_run_id ? await ctx.db.get(s.active_run_id) : null;
    const activeState = active ? (await runState(ctx, active)).status : null;
    const busy =
      (activeState === "queued" && active?.revision === s.revision) ||
      activeState === "uncertain_start" ||
      activeState === "starting" ||
      activeState === "running" ||
      activeState === "started" ||
      activeState === "finishing";
    if (args.manual && busy)
      throw new ConvexError("This schedule already has a run in progress.");
    const runId = await ctx.db.insert("schedule_runs", {
      schedule_id: s._id,
      user_id: s.user_id,
      occurrence,
      revision: s.revision,
      dispatcher_id: args.dispatcherId,
      dispatcher_run_id: args.dispatcherRunId,
      chat_id: args.chatId,
      status: busy ? "skipped" : args.queueOnly ? "queued" : "starting",
      detail: busy ? "Previous run is still in progress." : undefined,
      created_at: now,
    });
    const next = args.manual
      ? s.next_run_at
      : nextScheduledTime(s.definition.timing, now);
    await ctx.db.patch(s._id, {
      next_run_at: next ?? undefined,
      ...(!args.manual && next === null
        ? { enabled: false, consumed_at: now }
        : {}),
      ...(!busy ? { active_run_id: runId } : {}),
      ...(args.manual ? { last_manual_at: now } : {}),
      updated_at: now,
    });
    // Bounded retention prevents indefinite growth. Preserve current receipt.
    const old = await ctx.db
      .query("schedule_runs")
      .withIndex("by_schedule_id", (q) => q.eq("schedule_id", s._id))
      .order("desc")
      .take(201);
    if (old.length > 200) await ctx.db.delete(old[200]._id);
    return busy ? null : { id: runId, chatId: args.chatId };
  },
});
export const finishDispatch = mutation({
  args: {
    serviceKey: v.string(),
    id: v.id("schedule_runs"),
    dispatcherId: v.string(),
    status: scheduleRunStatus,
    triggerRunId: v.optional(v.string()),
    detail: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const r = await ctx.db.get(args.id);
    if (!r || r.dispatcher_id !== args.dispatcherId) return null;
    if (!["queued", "starting"].includes(r.status)) return null;
    await ctx.db.patch(r._id, {
      status: args.status,
      trigger_run_id: args.triggerRunId,
      detail: args.detail?.slice(0, 160),
    });
    return null;
  },
});

/** Final failure/cancellation unlocks future runs without replaying an uncertain start. */
export const failDispatcher = mutation({
  args: {
    serviceKey: v.string(),
    scheduleId: v.id("agent_schedules"),
    revision: v.number(),
    at: v.optional(v.number()),
    manual: v.boolean(),
    dispatcherId: v.string(),
    onlyCheck: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const occurrence = args.manual
      ? `manual:${args.dispatcherId}`
      : `${args.revision}:${args.at}`;
    const row = await ctx.db
      .query("schedule_runs")
      .withIndex("by_schedule_and_occurrence", (q) =>
        q.eq("schedule_id", args.scheduleId).eq("occurrence", occurrence),
      )
      .unique();
    if (
      !row ||
      row.dispatcher_id !== args.dispatcherId ||
      !["queued", "starting"].includes(row.status)
    )
      return null;
    await ctx.db.patch(row._id, { last_checked_at: Date.now() });
    if (args.onlyCheck) return null;
    // If the child started before its receipt write failed, retain the real run.
    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chat_id", (q) => q.eq("id", row.chat_id))
      .unique();
    if (chat?.active_trigger_run_id) {
      await ctx.db.patch(row._id, {
        status: "started",
        trigger_run_id: chat.active_trigger_run_id,
      });
    } else {
      await ctx.db.patch(row._id, {
        status: chat?.last_run_finished_at
          ? "unconfirmed"
          : row.dispatch_requested_at !== undefined
            ? "uncertain_start"
            : "failed",
        detail:
          "The run could not be confirmed. Check its task before trying again.",
      });
    }
    return null;
  },
});

export const unsettled = query({
  args: { serviceKey: v.string(), userId: v.optional(v.string()) },
  returns: v.array(
    v.object({ id: v.id("schedule_runs"), triggerRunId: v.string() }),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const rows = args.userId
      ? await ctx.db
          .query("schedule_runs")
          .withIndex("by_user_status_and_last_check", (q) =>
            q
              .eq("user_id", args.userId!)
              .eq("status", "started")
              .lt("last_checked_at", Date.now() - 30000),
          )
          .take(50)
      : await ctx.db
          .query("schedule_runs")
          .withIndex("by_status_and_last_check", (q) =>
            q.eq("status", "started").lt("last_checked_at", Date.now() - 30000),
          )
          .take(50);
    return rows.flatMap((r) =>
      r.trigger_run_id ? [{ id: r._id, triggerRunId: r.trigger_run_id }] : [],
    );
  },
});
export const recordOutcome = mutation({
  args: {
    serviceKey: v.string(),
    id: v.id("schedule_runs"),
    triggerRunId: v.string(),
    status: v.union(
      v.literal("finished"),
      v.literal("failed"),
      v.literal("canceled"),
      v.literal("unconfirmed"),
      v.literal("pending"),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const row = await ctx.db.get(args.id);
    if (
      !row ||
      row.trigger_run_id !== args.triggerRunId ||
      row.status !== "started"
    )
      return null;
    await ctx.db.patch(row._id, { last_checked_at: Date.now() });
    if (args.status === "pending") return null;
    if (args.status === "unconfirmed") {
      const chat = await ctx.db
        .query("chats")
        .withIndex("by_chat_id", (q) => q.eq("id", row.chat_id))
        .unique();
      // Cleanup proves execution ended, while its outcome remains unknown. Never unlock a still-active task.
      if (
        chat &&
        !chat.deletion_started_at &&
        (!chat.last_run_finished_at || chat.active_trigger_run_id)
      )
        return null;
    }
    await ctx.db.patch(row._id, {
      status: args.status,
      detail:
        args.status === "unconfirmed"
          ? "The result could not be confirmed. Open its task to inspect any saved output."
          : args.status === "failed"
            ? "The Agent run failed. Open its task for any saved output, or try Run now."
            : undefined,
    });
    return null;
  },
});

/** Durable manual outbox: the API can acknowledge a real receipt before external dispatch. */
export const queuedManual = query({
  args: { serviceKey: v.string() },
  returns: v.array(
    v.object({
      id: v.id("schedule_runs"),
      scheduleId: v.id("agent_schedules"),
      revision: v.number(),
      requestId: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const rows = await ctx.db
      .query("schedule_runs")
      .withIndex("by_status_and_last_check", (q) => q.eq("status", "queued"))
      .take(50);
    return rows.map((r) => ({
      id: r._id,
      scheduleId: r.schedule_id,
      revision: r.revision,
      requestId: r.dispatcher_id,
    }));
  },
});

export const beginDispatch = mutation({
  args: {
    serviceKey: v.string(),
    id: v.id("schedule_runs"),
    dispatcherId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const row = await ctx.db.get(args.id);
    if (
      !row ||
      row.status !== "starting" ||
      row.dispatcher_id !== args.dispatcherId
    )
      return false;
    const schedule = await ctx.db.get(row.schedule_id);
    if (
      !schedule ||
      schedule.revision !== row.revision ||
      (await isUserDeletionFenced(ctx.db, row.user_id))
    )
      return false;
    await ctx.db.patch(row._id, { dispatch_requested_at: Date.now() });
    return true;
  },
});
/** Repair abandoned dispatcher receipts only after its real terminal state is read. */
export const abandonedDispatches = query({
  args: { serviceKey: v.string() },
  returns: v.array(
    v.object({
      scheduleId: v.id("agent_schedules"),
      revision: v.number(),
      at: v.optional(v.number()),
      manual: v.boolean(),
      dispatcherId: v.string(),
      dispatcherRunId: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const rows = await ctx.db
      .query("schedule_runs")
      .withIndex("by_status_and_last_check", (q) =>
        q.eq("status", "starting").lt("last_checked_at", Date.now() - 60000),
      )
      .take(50);
    return rows.flatMap((row) =>
      row.created_at < Date.now() - 600000 && row.dispatcher_run_id
        ? [
            {
              scheduleId: row.schedule_id,
              revision: row.revision,
              manual: row.occurrence.startsWith("manual:"),
              ...(row.occurrence.startsWith("manual:")
                ? {}
                : { at: Number(row.occurrence.split(":")[1]) }),
              dispatcherId: row.dispatcher_id,
              dispatcherRunId: row.dispatcher_run_id,
            },
          ]
        : [],
    );
  },
});
