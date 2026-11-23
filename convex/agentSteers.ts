import { ConvexError, v } from "convex/values";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./lib/serviceFunctions";
import { validateServiceKey } from "./lib/utils";
import type { Doc } from "./_generated/dataModel";
import {
  AGENT_STEER_MAX_PENDING,
  AGENT_STEER_MAX_TEXT_LENGTH,
  isValidAgentSteerId,
} from "../lib/chat/agent-steer";

async function requireUserId(ctx: QueryCtx | MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new ConvexError({
      code: "UNAUTHORIZED",
      message: "Unauthorized: User not authenticated",
    });
  }
  return identity.subject;
}

async function getOwnedChat(
  ctx: QueryCtx | MutationCtx,
  chatId: string,
  userId: string,
) {
  const chat = await ctx.db
    .query("chats")
    .withIndex("by_chat_id", (q) => q.eq("id", chatId))
    .first();
  if (!chat || chat.user_id !== userId || chat.deletion_started_at) return null;
  return chat;
}

/**
 * Target the chat's active Trigger run. Without one there is nothing to steer;
 * the client queues the message instead.
 */
export const create = mutation({
  args: { chatId: v.string(), id: v.string(), text: v.string() },
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
    const pending = await ctx.db
      .query("agent_steers")
      .withIndex("by_chat_id", (q) => q.eq("chat_id", args.chatId))
      .take(AGENT_STEER_MAX_PENDING);
    if (pending.length >= AGENT_STEER_MAX_PENDING) {
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
      created_at: Date.now(),
    });
    return "pending" as const;
  },
});

type SteerRow = Doc<"agent_steers">;

/**
 * The client may take back a steer nobody holds: one the run has not claimed,
 * or one claimed by a run that is no longer active and never acknowledged.
 */
const isWithdrawable = (row: SteerRow, activeRunId: string | undefined) =>
  row.claimed_at === undefined || row.run_id !== activeRunId;

/** Steers no running Agent holds, oldest first. */
export const listPending = query({
  args: { chatId: v.string() },
  returns: v.array(
    v.object({
      id: v.string(),
      text: v.string(),
      runId: v.string(),
      createdAt: v.number(),
      claimed: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const chat = await getOwnedChat(ctx, args.chatId, identity.subject);
    if (!chat) return [];
    const rows = await ctx.db
      .query("agent_steers")
      .withIndex("by_chat_id", (q) => q.eq("chat_id", args.chatId))
      .take(AGENT_STEER_MAX_PENDING);
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
        createdAt: row.created_at,
        claimed: row.claimed_at !== undefined,
      }));
  },
});

/**
 * Take back a steer no running Agent holds, for example after its run ended.
 * This races the run's claim inside one transaction, so exactly one side gets
 * the text.
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
    if (
      row.claimed_at !== undefined &&
      chat?.active_trigger_run_id === row.run_id
    )
      return { outcome: "not_found" as const };
    await ctx.db.delete(row._id);
    return { outcome: "withdrawn" as const, text: row.text };
  },
});

/**
 * The owning run reads steers before a model step. The run never deletes a
 * row: a claim whose response was lost returns the same steer on the next
 * step, and after the run the client keeps the saved transcript as the
 * record, removing claimed rows it shows and queueing any it does not.
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
        .withIndex("by_run_id", (q) => q.eq("run_id", args.runId))
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
