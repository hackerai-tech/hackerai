import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { validateServiceKey } from "./lib/utils";
import { isUserDeletionFenced } from "./lib/userDeletionFence";
import {
  taskOutcomeAnswer,
  taskOutcomeContext,
  taskOutcomeDocument,
  taskOutcomeReason,
} from "./taskOutcomeValidators";
import {
  TASK_OUTCOME_COOLDOWN_MS,
  TASK_OUTCOME_EXPIRY_MS,
  reasonsForAnswer,
} from "../lib/feedback/task-outcome";

// Service-only reservation occurs before model-priced checks or generation. The
// indexed read + insert is atomic, including simultaneous runs on other devices.
export const reserve = mutation({
  args: { serviceKey: v.string(), user_id: v.string(), ...taskOutcomeContext },
  returns: v.union(taskOutcomeDocument, v.null()),
  handler: async (ctx, { serviceKey, ...args }) => {
    validateServiceKey(serviceKey);
    if (await isUserDeletionFenced(ctx.db, args.user_id)) return null;
    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chat_id", (q) => q.eq("id", args.chat_id))
      .unique();
    if (!chat || chat.user_id !== args.user_id) return null;
    const existing = await ctx.db
      .query("task_outcome_surveys")
      .withIndex("by_request_id", (q) => q.eq("request_id", args.request_id))
      .unique();
    if (existing) return null;
    const previous = await ctx.db
      .query("task_outcome_surveys")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.user_id))
      .order("desc")
      .first();
    const now = Date.now();
    if (
      previous &&
      now - previous.last_interaction_at < TASK_OUTCOME_COOLDOWN_MS
    )
      return null;
    const id = await ctx.db.insert("task_outcome_surveys", {
      ...args,
      selected_at: now,
      last_interaction_at: now,
      expires_at: now + TASK_OUTCOME_EXPIRY_MS,
    });
    return await ctx.db.get(id);
  },
});

export const linkMessage = mutation({
  args: {
    serviceKey: v.string(),
    user_id: v.string(),
    request_id: v.string(),
    message_id: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const row = await ctx.db
      .query("task_outcome_surveys")
      .withIndex("by_request_id", (q) => q.eq("request_id", args.request_id))
      .unique();
    if (
      row &&
      row.user_id === args.user_id &&
      !row.answered_at &&
      !row.dismissed_at
    )
      await ctx.db.patch(row._id, { message_id: args.message_id });
    return null;
  },
});

export const getForMessage = query({
  args: { chat_id: v.string(), message_id: v.string() },
  returns: v.union(taskOutcomeDocument, v.null()),
  handler: async (ctx, args) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user) return null;
    const row = await ctx.db
      .query("task_outcome_surveys")
      .withIndex("by_user_id", (q) => q.eq("user_id", user.subject))
      .order("desc")
      .first();
    if (
      !row ||
      row.chat_id !== args.chat_id ||
      row.message_id !== args.message_id ||
      row.expires_at <= Date.now() ||
      row.dismissed_at ||
      row.answered_at
    )
      return null;
    return row;
  },
});

export const record = mutation({
  args: {
    id: v.id("task_outcome_surveys"),
    action: v.union(
      v.literal("shown"),
      v.literal("dismissed"),
      v.literal("answered"),
      v.literal("reason"),
    ),
    answer: v.optional(taskOutcomeAnswer),
    reason: v.optional(taskOutcomeReason),
  },
  returns: v.union(taskOutcomeDocument, v.null()),
  handler: async (ctx, args) => {
    const user = await ctx.auth.getUserIdentity();
    const row = await ctx.db.get(args.id);
    if (!user || !row || row.user_id !== user.subject)
      throw new ConvexError("Not authorized");
    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chat_id", (q) => q.eq("id", row.chat_id))
      .unique();
    if (
      !chat ||
      chat.user_id !== user.subject ||
      (await isUserDeletionFenced(ctx.db, user.subject))
    )
      return null;
    if (row.expires_at <= Date.now() || row.dismissed_at) return null;
    const now = Date.now();
    if (args.action === "shown") {
      // Return null on another tab/device's claim, so only one surface asks.
      if (row.shown_at || row.answered_at) return null;
      await ctx.db.patch(row._id, { shown_at: now, last_interaction_at: now });
    } else if (args.action === "dismissed") {
      if (!row.shown_at || row.answered_at) return null;
      await ctx.db.patch(row._id, {
        dismissed_at: now,
        last_interaction_at: now,
      });
    } else if (args.action === "answered") {
      if (!row.shown_at || !args.answer) return null;
      if (row.answer) return row.answer === args.answer ? row : null;
      await ctx.db.patch(row._id, {
        answer: args.answer,
        answered_at: now,
        last_interaction_at: now,
      });
    } else {
      if (
        !row.answer ||
        !args.reason ||
        !reasonsForAnswer(row.answer).includes(args.reason)
      )
        return null;
      if (row.reason) return row.reason === args.reason ? row : null;
      await ctx.db.patch(row._id, { reason: args.reason });
    }
    return await ctx.db.get(row._id);
  },
});
