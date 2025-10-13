import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export function validateServiceKey(serviceKey?: string): void {
  if (serviceKey && serviceKey !== process.env.CONVEX_SERVICE_ROLE_KEY) {
    throw new Error("Unauthorized: Invalid service key");
  }
}

/**
 * Start (or refresh) a temporary stream coordination row.
 * Backend-only via service key.
 */
export const startTempStream = mutation({
  args: {
    serviceKey: v.optional(v.string()),
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
      throw new Error("Unauthorized: User not authenticated");
    }

    const row = await ctx.db
      .query("temp_streams")
      .withIndex("by_chat_id", (q) => q.eq("chat_id", args.chatId))
      .first();

    if (!row) return null;

    if (row.user_id !== identity.subject) {
      throw new Error("Unauthorized: Temp stream does not belong to user");
    }

    await ctx.db.delete(row._id);

    return null;
  },
});

/**
 * Backend-only status check (service key).
 */
export const getTempCancellationStatus = query({
  args: { serviceKey: v.optional(v.string()), chatId: v.string() },
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
  args: { serviceKey: v.optional(v.string()), chatId: v.string() },
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
