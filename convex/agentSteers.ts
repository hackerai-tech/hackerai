import { ConvexError, v } from "convex/values";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./lib/serviceFunctions";
import { getOwnedChat, requireUserId } from "./lib/ownedChat";
import { queuedMessageSettingsValidator } from "./lib/queuedMessageSettings";
import { findQueuedMessage, insertQueuedMessage } from "./lib/queuedMessages";
import { validateServiceKey } from "./lib/utils";
import type { Doc } from "./_generated/dataModel";
import {
  AGENT_STEER_SCAN_LIMIT,
  AGENT_STEER_TOMBSTONE_TTL_MS,
  isOpenSteer,
  settleSteer,
} from "./lib/agentSteers";
import {
  AGENT_STEER_MAX_PENDING,
  AGENT_STEER_MAX_TEXT_LENGTH,
  isValidAgentSteerId,
} from "../lib/chat/agent-steer";

/**
 * Target the chat's active Trigger run. Without one there is nothing to steer;
 * the client queues the message instead.
 */
export const create = mutation({
  args: {
    chatId: v.string(),
    id: v.string(),
    text: v.string(),
    /** Browser time, comparable with queued messages for restore order. */
    sentAt: v.number(),
    /** A queued message being steered; it leaves the queue with this write. */
    queuedId: v.optional(v.string()),
    /** The user's Agent settings, kept if the steer returns to the queue. */
    settings: v.optional(queuedMessageSettingsValidator),
  },
  returns: v.union(v.literal("pending"), v.literal("no_active_run")),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const text = args.text.trim();
    if (
      !isValidAgentSteerId(args.id) ||
      !text ||
      text.length > AGENT_STEER_MAX_TEXT_LENGTH
    ) {
      throw new ConvexError({
        code: "INVALID_STEER",
        message: "This message cannot steer the current run.",
      });
    }
    const chat = await getOwnedChat(ctx, args.chatId, userId);
    if (!chat) {
      throw new ConvexError({
        code: "ACCESS_DENIED",
        message: "Unauthorized: Chat not found",
      });
    }
    const runId = chat.active_trigger_run_id;
    if (!runId) return "no_active_run" as const;
    const existing = await ctx.db
      .query("agent_steers")
      .withIndex("by_steer_id", (q) => q.eq("id", args.id))
      .first();
    if (existing) {
      throw new ConvexError({
        code: "INVALID_STEER",
        message: "This message was already sent.",
      });
    }
    const now = Date.now();
    // Tombstone cleanup reads only expired settled rows.
    const expired = await ctx.db
      .query("agent_steers")
      .withIndex("by_chat_and_settled", (q) =>
        q
          .eq("chat_id", args.chatId)
          .gte("settled_at", 0)
          .lt("settled_at", now - AGENT_STEER_TOMBSTONE_TTL_MS),
      )
      .take(AGENT_STEER_SCAN_LIMIT);
    for (const row of expired) await ctx.db.delete(row._id);
    if (
      (await openSteersForChat(ctx, args.chatId)).length >=
      AGENT_STEER_MAX_PENDING
    ) {
      throw new ConvexError({
        code: "STEER_LIMIT",
        message: "Wait for the Agent to read your earlier messages.",
      });
    }
    await ctx.db.insert("agent_steers", {
      id: args.id,
      chat_id: args.chatId,
      user_id: userId,
      run_id: runId,
      text,
      created_at: now,
      sent_at: args.sentAt,
      ...(args.settings ? { settings: args.settings } : {}),
    });
    if (args.queuedId) {
      const queued = await findQueuedMessage(ctx, args.queuedId);
      // An edit made while this steer was on its way stays queued.
      if (
        queued &&
        queued.user_id === userId &&
        queued.chat_id === args.chatId &&
        queued.text.trim() === text
      )
        await ctx.db.delete(queued._id);
    }
    return "pending" as const;
  },
});

type SteerRow = Doc<"agent_steers">;

/** Open steers come straight from the index, never behind tombstones. */
const openSteersForChat = (ctx: QueryCtx | MutationCtx, chatId: string) =>
  ctx.db
    .query("agent_steers")
    .withIndex("by_chat_and_settled", (q) =>
      q.eq("chat_id", chatId).eq("settled_at", undefined),
    )
    .take(AGENT_STEER_MAX_PENDING);

/**
 * The client may take back a steer nobody holds: one the run has not claimed,
 * or one claimed by a run that is no longer active and never acknowledged.
 */
const isWithdrawable = (row: SteerRow, activeRunId: string | undefined) =>
  isOpenSteer(row) &&
  (row.claimed_at === undefined || row.run_id !== activeRunId);

/** Steers no running Agent holds, oldest first. */
export const listPending = query({
  args: { chatId: v.string() },
  returns: v.array(
    v.object({
      id: v.string(),
      text: v.string(),
      runId: v.string(),
      sentAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const chat = await getOwnedChat(ctx, args.chatId, identity.subject);
    if (!chat) return [];
    const rows = await openSteersForChat(ctx, args.chatId);
    return rows
      .filter(
        (row) =>
          row.user_id === identity.subject &&
          isWithdrawable(row, chat.active_trigger_run_id),
      )
      .sort((a, b) => a.created_at - b.created_at)
      .map((row) => ({
        id: row.id,
        text: row.text,
        runId: row.run_id,
        sentAt: row.sent_at ?? row.created_at,
      }));
  },
});

/**
 * Return a steer no running Agent holds to the chat's queue, for example
 * after its run ended. This races the run's claim inside one transaction. An
 * open row was never saved in a response, so its text is safe to queue
 * again; a save that arrives later drops it (`withoutWithdrawnSteers`). The
 * queued copy keeps the steer's ID, so saving it as a user message later
 * retires the queued row.
 */
export const withdraw = mutation({
  args: { chatId: v.string(), id: v.string() },
  returns: v.union(
    v.object({ outcome: v.literal("withdrawn"), text: v.string() }),
    v.object({ outcome: v.literal("not_found") }),
  ),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const row = await ctx.db
      .query("agent_steers")
      .withIndex("by_steer_id", (q) => q.eq("id", args.id))
      .first();
    if (!row || row.user_id !== userId || row.chat_id !== args.chatId)
      return { outcome: "not_found" as const };
    const chat = await getOwnedChat(ctx, args.chatId, userId);
    if (!isWithdrawable(row, chat?.active_trigger_run_id))
      return { outcome: "not_found" as const };
    // A tombstone: a late save from a stopped worker must drop this steer.
    await settleSteer(ctx, row, "withdrawn");
    await insertQueuedMessage(ctx, {
      id: row.id,
      chatId: row.chat_id,
      userId,
      text: row.text,
      sentAt: row.sent_at ?? row.created_at,
      fromSteer: true,
      ...(row.settings ? { settings: row.settings } : {}),
    });
    return { outcome: "withdrawn" as const, text: row.text };
  },
});

/**
 * The owning run reads steers before a model step. The run never deletes a
 * row: a claim whose response was lost returns the same steer on the next
 * step. Saving the response that shows a steer retires its row
 * (`retireSavedSteers`), and after the run the client returns any that
 * remain to the queue (`withdraw`).
 */
export const claimForBackend = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    chatId: v.string(),
    runId: v.string(),
  },
  returns: v.array(v.object({ id: v.string(), text: v.string() })),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const chat = await getOwnedChat(ctx, args.chatId, args.userId);
    if (!chat || chat.active_trigger_run_id !== args.runId) return [];
    const rows = (
      await ctx.db
        .query("agent_steers")
        .withIndex("by_run_and_settled", (q) =>
          q.eq("run_id", args.runId).eq("settled_at", undefined),
        )
        .take(AGENT_STEER_MAX_PENDING)
    ).filter(
      (row) => row.chat_id === args.chatId && row.user_id === args.userId,
    );
    const now = Date.now();
    for (const row of rows)
      if (row.claimed_at === undefined)
        await ctx.db.patch(row._id, { claimed_at: now });
    return rows
      .sort((a, b) => a.created_at - b.created_at)
      .map((row) => ({ id: row.id, text: row.text }));
  },
});
