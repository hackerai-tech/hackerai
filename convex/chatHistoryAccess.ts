import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internalMutation } from "./lib/serviceFunctions";
import { createChatHistoryAccess } from "./lib/chatHistoryAccess";

// Explicit, bounded migration. Never scheduled by deployment or a client read.
export const backfill = internalMutation({
  args: { paginationOpts: paginationOptsValidator },
  returns: v.object({
    isDone: v.boolean(),
    continueCursor: v.string(),
    created: v.number(),
  }),
  handler: async (ctx, args) => {
    const page = await ctx.db.query("chats").paginate({
      ...args.paginationOpts,
      numItems: Math.min(100, Math.max(1, args.paginationOpts.numItems)),
      maximumBytesRead: 2 * 1024 * 1024,
    });
    let created = 0;
    for (const chat of page.page) {
      const access = await ctx.db
        .query("chat_history_access")
        .withIndex("by_chat_id", (q) => q.eq("chat_id", chat.id))
        .unique();
      if (!access) {
        await createChatHistoryAccess(ctx, chat.id, chat.user_id);
        created++;
      } else if (access.user_id !== chat.user_id)
        throw new Error("Chat history ownership mismatch");
    }
    return {
      isDone: page.isDone,
      continueCursor: page.continueCursor,
      created,
    };
  },
});
