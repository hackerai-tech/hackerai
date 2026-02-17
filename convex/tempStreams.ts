import { query, mutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import { validateServiceKey } from "./lib/utils";

/**
 * Start (or refresh) a temporary stream coordination row.
 * Backend-only via service key.
 */
export const startTempStream = mutation({
  args: {
    serviceKey: v.string(),
    chatId: v.string(),
    userId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const existing = await ctx.db
      .query("temp_streams")
      .withIndex("by_chat_id", (q) => q.eq("chat_id", args.chatId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        user_id: args.userId,
      });
    } else {
      await ctx.db.insert("temp_streams", {
        chat_id: args.chatId,
        user_id: args.userId,
      });
    }

    return null;
  },
});

/**
 * Client-callable cancel for temp streams.
 */
export const cancelTempStreamFromClient = mutation({
  args: {
    chatId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Unauthorized: User not authenticated",
      });
    }

    const row = await ctx.db
      .query("temp_streams")
      .withIndex("by_chat_id", (q) => q.eq("chat_id", args.chatId))
      .first();

    if (!row) return null;

    if (row.user_id !== identity.subject) {
      throw new ConvexError({
        code: "ACCESS_DENIED",
        message: "Unauthorized: Temp stream does not belong to user",
      });
    }

    await ctx.db.delete(row._id);

    // Publish cancellation to Redis for instant backend notification
    await ctx.scheduler.runAfter(0, internal.redisPubsub.publishCancellation, {
      chatId: args.chatId,
    });

    return null;
  },
});

/**
 * Backend-only status check (service key).
 */
export const getTempCancellationStatus = query({
  args: { serviceKey: v.string(), chatId: v.string() },
  returns: v.union(
    v.object({
      canceled: v.boolean(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const row = await ctx.db
      .query("temp_streams")
      .withIndex("by_chat_id", (q) => q.eq("chat_id", args.chatId))
      .first();

    if (!row) return { canceled: true };
    return { canceled: false };
  },
});

/**
 * Backend-only delete by chatId (idempotent).
 */
export const deleteTempStreamForBackend = mutation({
  args: { serviceKey: v.string(), chatId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const row = await ctx.db
      .query("temp_streams")
      .withIndex("by_chat_id", (q) => q.eq("chat_id", args.chatId))
      .first();

    if (row) {
      await ctx.db.delete(row._id);
    }
    return null;
  },
});
