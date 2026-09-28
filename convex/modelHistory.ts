import { v } from "convex/values";
import { mutation, type MutationCtx } from "./_generated/server";
import { validateServiceKey } from "./lib/utils";
import { assertUserCanAccessChatHistory } from "./lib/suspensionGuards";

/** Tombstone revisions fence in-flight writes after edits/regeneration. */
export async function invalidateModelHistory(ctx: MutationCtx, chatId: string) {
  const row = await ctx.db
    .query("model_history")
    .withIndex("by_chat_id", (q) => q.eq("chat_id", chatId))
    .unique();
  if (row)
    await ctx.db.patch(row._id, {
      revision: row.revision + 1,
      payload: undefined,
    });
}

export async function deleteModelHistory(ctx: MutationCtx, chatId: string) {
  const row = await ctx.db
    .query("model_history")
    .withIndex("by_chat_id", (q) => q.eq("chat_id", chatId))
    .unique();
  if (row) await ctx.db.delete(row._id);
}

// Backends use service authentication; no client or shared-chat snapshot exposes payloads.
export const load = mutation({
  args: { serviceKey: v.string(), chatId: v.string(), userId: v.string() },
  returns: v.union(
    v.null(),
    v.object({ revision: v.number(), payload: v.union(v.string(), v.null()) }),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    await assertUserCanAccessChatHistory(ctx, args.userId);
    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chat_id", (q) => q.eq("id", args.chatId))
      .unique();
    if (!chat || chat.user_id !== args.userId || chat.deletion_started_at)
      return null;
    const row = await ctx.db
      .query("model_history")
      .withIndex("by_chat_id", (q) => q.eq("chat_id", args.chatId))
      .unique();
    if (row) {
      // Claim the next run: an older worker cannot overwrite its successor.
      await ctx.db.patch(row._id, { revision: row.revision + 1 });
      return { revision: row.revision + 1, payload: row.payload ?? null };
    }
    await ctx.db.insert("model_history", {
      chat_id: args.chatId,
      revision: 0,
      started_at: 0,
    });
    return { revision: 0, payload: null };
  },
});

export const save = mutation({
  args: {
    serviceKey: v.string(),
    chatId: v.string(),
    userId: v.string(),
    revision: v.number(),
    startedAt: v.number(),
    payload: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    await assertUserCanAccessChatHistory(ctx, args.userId);
    if (new TextEncoder().encode(args.payload).byteLength > 700_000)
      return false;
    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chat_id", (q) => q.eq("id", args.chatId))
      .unique();
    if (!chat || chat.user_id !== args.userId || chat.deletion_started_at)
      return false;
    const row = await ctx.db
      .query("model_history")
      .withIndex("by_chat_id", (q) => q.eq("chat_id", args.chatId))
      .unique();
    if (
      !row ||
      row.revision !== args.revision ||
      row.started_at > args.startedAt
    )
      return false;
    await ctx.db.patch(row._id, {
      payload: args.payload,
      started_at: args.startedAt,
    });
    return true;
  },
});
