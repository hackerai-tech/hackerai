import { ConvexError, v } from "convex/values";
import { mutation, query } from "./lib/serviceFunctions";
import { getOwnedChat, requireUserId } from "./lib/ownedChat";
import {
  findQueuedMessage,
  insertQueuedMessage,
  isDispatchClaimed,
  queuedMessagesForChat,
} from "./lib/queuedMessages";
import { AGENT_STEER_MAX_PENDING } from "../lib/chat/agent-steer";
import { QUEUED_MESSAGE_MAX_TEXT_LENGTH } from "../lib/chat/queued-message";
import { validateServiceKey } from "./lib/utils";
import { queuedMessageSettingsValidator } from "./lib/queuedMessageSettings";
import { settleSteer } from "./lib/agentSteers";

const queuedMessageValidator = v.object({
  id: v.string(),
  text: v.string(),
  files: v.optional(v.array(v.any())),
  sentAt: v.number(),
  fromSteer: v.boolean(),
  /** While the server sends it: when its claim started (the lease ends later). */
  dispatchClaimedAt: v.optional(v.number()),
});

/** The chat's queue, oldest first. */
export const list = query({
  args: { chatId: v.string() },
  returns: v.array(queuedMessageValidator),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    if (!(await getOwnedChat(ctx, args.chatId, identity.subject))) return [];
    const rows = await queuedMessagesForChat(ctx, args.chatId);
    const now = Date.now();
    return rows
      .filter((row) => row.user_id === identity.subject)
      .map((row) => ({
        id: row.id,
        text: row.text,
        ...(row.files?.length ? { files: row.files } : {}),
        sentAt: row.sent_at,
        fromSteer: row.from_steer === true,
        ...(isDispatchClaimed(row, now)
          ? { dispatchClaimedAt: row.dispatch_claimed_at }
          : {}),
      }));
  },
});

export const enqueue = mutation({
  args: {
    chatId: v.string(),
    id: v.string(),
    text: v.string(),
    files: v.optional(v.array(v.any())),
    sentAt: v.number(),
    settings: v.optional(queuedMessageSettingsValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    if (!(await getOwnedChat(ctx, args.chatId, userId))) {
      throw new ConvexError({
        code: "ACCESS_DENIED",
        message: "Unauthorized: Chat not found",
      });
    }
    await insertQueuedMessage(ctx, { ...args, userId });
    return null;
  },
});

async function ownedRow(
  ctx: Parameters<typeof requireUserId>[0],
  args: { chatId: string; id: string },
) {
  const userId = await requireUserId(ctx);
  const row = await findQueuedMessage(ctx, args.id);
  return row && row.user_id === userId && row.chat_id === args.chatId
    ? row
    : null;
}

const sendingError = () =>
  new ConvexError({
    code: "QUEUED_MESSAGE_SENDING",
    message: "This message is already being sent.",
  });

/** Edits a queued message's text. Missing rows were already sent or removed. */
export const update = mutation({
  args: { chatId: v.string(), id: v.string(), text: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.text.length > QUEUED_MESSAGE_MAX_TEXT_LENGTH) {
      throw new ConvexError({
        code: "INVALID_QUEUED_MESSAGE",
        message: "This message is too long to queue.",
      });
    }
    const row = await ownedRow(ctx, args);
    if (row && isDispatchClaimed(row, Date.now())) throw sendingError();
    if (row) await ctx.db.patch(row._id, { text: args.text });
    return null;
  },
});

export const remove = mutation({
  args: { chatId: v.string(), id: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ownedRow(ctx, args);
    // A server send holds its row until the run is attached; removing it
    // would let the next message start first.
    if (row && isDispatchClaimed(row, Date.now())) throw sendingError();
    if (row) await ctx.db.delete(row._id);
    return null;
  },
});

const ACTIVE_GOAL_STATES = new Set([
  "queued",
  "running",
  "waiting",
  "needs_approval",
]);

/**
 * After a run finishes normally, claims the chat's next queued message for
 * the server to send, as T3 Code does. Nothing is claimed when the user must
 * act first: the run stopped or failed (no normal finish), the Agent waits for
 * a reply, a goal owns the chat, or another run already started. Steers the
 * finished run never read join the queue first, in send order.
 */
export const claimNextForDispatch = mutation({
  args: {
    serviceKey: v.string(),
    chatId: v.string(),
    userId: v.string(),
    completedRunId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      id: v.string(),
      text: v.string(),
      files: v.optional(v.array(v.any())),
      sentAt: v.number(),
      fromSteer: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const chat = await getOwnedChat(ctx, args.chatId, args.userId);
    if (
      !chat ||
      (chat.active_trigger_run_id !== undefined &&
        chat.active_trigger_run_id !== args.completedRunId) ||
      chat.canceled_at !== undefined ||
      chat.active_agent_user_wait !== undefined ||
      chat.finish_reason !== "stop"
    )
      return null;
    const goal = await ctx.db
      .query("agent_goals")
      .withIndex("by_chatId", (q) => q.eq("chatId", args.chatId))
      .first();
    if (
      goal &&
      goal.deletedAt === undefined &&
      (goal.activeRunId !== undefined || ACTIVE_GOAL_STATES.has(goal.state))
    )
      return null;

    const unread = await ctx.db
      .query("agent_steers")
      .withIndex("by_run_and_settled", (q) =>
        q.eq("run_id", args.completedRunId).eq("settled_at", undefined),
      )
      .take(AGENT_STEER_MAX_PENDING);
    for (const steer of unread) {
      if (steer.chat_id !== args.chatId || steer.user_id !== args.userId)
        continue;
      // Settled as withdrawn, so a later save drops it (withoutWithdrawnSteers).
      await settleSteer(ctx, steer, "withdrawn");
      await insertQueuedMessage(ctx, {
        id: steer.id,
        chatId: steer.chat_id,
        userId: steer.user_id,
        text: steer.text,
        sentAt: steer.sent_at ?? steer.created_at,
        fromSteer: true,
        ...(steer.settings ? { settings: steer.settings } : {}),
      });
    }

    const queue = (await queuedMessagesForChat(ctx, args.chatId)).filter(
      (row) => row.user_id === args.userId,
    );
    const now = Date.now();
    const next = queue[0];
    if (
      !next ||
      // One send at a time per chat, whichever row it holds.
      queue.some((row) => isDispatchClaimed(row, now)) ||
      // Only a message whose current settings allow unattended work starts
      // without the browser; the browser sends the rest with its approvals.
      next.settings?.agentPermissionMode !== "full_access" ||
      // Local Desktop attachments exist only in the browser that queued them.
      next.files?.some(
        (file) => (file as { storage?: unknown })?.storage === "local-desktop",
      )
    )
      return null;
    await ctx.db.patch(next._id, {
      dispatch_claimed_at: now,
      dispatch_run_id: args.completedRunId,
    });
    return {
      id: next.id,
      text: next.text,
      ...(next.files?.length ? { files: next.files } : {}),
      sentAt: next.sent_at,
      fromSteer: next.from_steer === true,
    };
  },
});

/** The claimed message, if this dispatch still owns it. */
export const getClaimedForDispatch = query({
  args: {
    serviceKey: v.string(),
    chatId: v.string(),
    userId: v.string(),
    id: v.string(),
    completedRunId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      id: v.string(),
      text: v.string(),
      files: v.optional(v.array(v.any())),
      settings: v.optional(queuedMessageSettingsValidator),
    }),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const row = await findQueuedMessage(ctx, args.id);
    if (
      !row ||
      row.chat_id !== args.chatId ||
      row.user_id !== args.userId ||
      row.dispatch_run_id !== args.completedRunId ||
      // An expired lease is the user's again; never send it from here.
      !isDispatchClaimed(row, Date.now())
    )
      return null;
    return {
      id: row.id,
      text: row.text,
      ...(row.files?.length ? { files: row.files } : {}),
      ...(row.settings ? { settings: row.settings } : {}),
    };
  },
});

/** A dispatch that could not start leaves the message for the user. */
export const releaseDispatch = mutation({
  args: {
    serviceKey: v.string(),
    chatId: v.string(),
    userId: v.string(),
    id: v.string(),
    completedRunId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const row = await findQueuedMessage(ctx, args.id);
    if (
      row &&
      row.chat_id === args.chatId &&
      row.user_id === args.userId &&
      row.dispatch_run_id === args.completedRunId
    )
      await ctx.db.patch(row._id, {
        dispatch_claimed_at: undefined,
        dispatch_run_id: undefined,
      });
    return null;
  },
});

/** The started run is attached to the chat: the queued row is done. */
export const completeDispatch = mutation({
  args: {
    serviceKey: v.string(),
    chatId: v.string(),
    userId: v.string(),
    id: v.string(),
    completedRunId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const row = await findQueuedMessage(ctx, args.id);
    if (
      row &&
      row.chat_id === args.chatId &&
      row.user_id === args.userId &&
      row.dispatch_run_id === args.completedRunId
    )
      await ctx.db.delete(row._id);
    return null;
  },
});

/**
 * The user changed their Agent settings (permission mode, sandbox or model):
 * every message still waiting for them, queued or steered, follows the new
 * choice, as it would if the browser sent it now.
 */
export const applySettings = mutation({
  args: { settings: queuedMessageSettingsValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const queued = await ctx.db
      .query("queued_messages")
      .withIndex("by_user", (q) => q.eq("user_id", userId))
      .take(QUEUED_SETTINGS_SCAN_LIMIT);
    for (const row of queued)
      await ctx.db.patch(row._id, { settings: args.settings });
    const steers = await ctx.db
      .query("agent_steers")
      .withIndex("by_user_and_settled", (q) =>
        q.eq("user_id", userId).eq("settled_at", undefined),
      )
      .take(QUEUED_SETTINGS_SCAN_LIMIT);
    for (const steer of steers)
      await ctx.db.patch(steer._id, { settings: args.settings });
    return null;
  },
});

const QUEUED_SETTINGS_SCAN_LIMIT = 500;
