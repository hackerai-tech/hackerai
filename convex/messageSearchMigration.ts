import { v } from "convex/values";
import { internalMutation } from "./lib/serviceFunctions";
import {
  getMessageSearchMigration,
  syncMessageSearch,
} from "./lib/messageSearch";

// Operator-driven, never started by deploy, a client, or a scheduled job.
// Restore must finish before deploying code that only reads messages.content.
export const start = internalMutation({
  args: { direction: v.union(v.literal("separate"), v.literal("restore")) },
  returns: v.null(),
  handler: async (ctx, { direction }) => {
    const state = await getMessageSearchMigration(ctx);
    if (direction === "separate") {
      if (!state) {
        await ctx.db.insert("message_search_migration", {
          name: "search_text",
          phase: "copying",
          cursor: null,
        });
      } else if (state.phase === "legacy") {
        await ctx.db.patch(state._id, { phase: "copying", cursor: null });
      } else if (state.phase === "restoring") {
        throw new Error("Finish restoring message search first");
      }
    } else if (
      state &&
      state.phase !== "legacy" &&
      state.phase !== "restoring"
    ) {
      if (state.phase === "copying" || state.phase === "pruning") {
        // Legacy text has not been removed yet.
        await ctx.db.patch(state._id, { phase: "legacy", cursor: null });
      } else {
        await ctx.db.patch(state._id, { phase: "restoring", cursor: null });
      }
    }
    return null;
  },
});

export const advance = internalMutation({
  args: {},
  returns: v.object({
    phase: v.string(),
    processed: v.number(),
    done: v.boolean(),
  }),
  handler: async (ctx) => {
    const state = await getMessageSearchMigration(ctx);
    if (!state) throw new Error("Start message search migration explicitly");
    if (state.phase === "ready" || state.phase === "legacy")
      return { phase: state.phase, processed: 0, done: true };
    if (state.phase === "pruning") {
      // Old code can delete bodies after a completed restore. Do not expose
      // their stale search rows on re-cutover. Each existence check reads a
      // potentially 1 MiB body, so also bound this pass to eight lookups.
      const page = await ctx.db
        .query("message_search")
        .order("asc")
        .paginate({
          cursor: state.cursor,
          numItems: 8,
          maximumBytesRead: 1024 * 1024,
        });
      for (const search of page.page) {
        if (!(await ctx.db.get(search.message_id)))
          await ctx.db.delete(search._id);
      }
      const phase = page.isDone ? "stripping" : "pruning";
      await ctx.db.patch(state._id, {
        phase,
        cursor: page.isDone ? null : page.continueCursor,
      });
      return { phase, processed: page.page.length, done: false };
    }
    const page = await ctx.db
      .query("messages")
      .order("asc")
      .paginate({
        cursor: state.cursor,
        numItems: 100,
        maximumBytesRead: 1024 * 1024,
      });
    for (const message of page.page) {
      if (state.phase === "copying") {
        await syncMessageSearch(ctx, message);
      } else if (state.phase === "stripping") {
        if (message.content !== undefined) {
          // Preserve the last legacy copy even if an incomplete cleanup or a
          // previous writer left its search row missing before this pass.
          await syncMessageSearch(ctx, message);
          await ctx.db.patch(message._id, { content: undefined });
        } else {
          const search = await ctx.db
            .query("message_search")
            .withIndex("by_message_id", (q) => q.eq("message_id", message._id))
            .unique();
          if (!search)
            throw new Error("Message search document missing before stripping");
        }
      } else {
        const search = await ctx.db
          .query("message_search")
          .withIndex("by_message_id", (q) => q.eq("message_id", message._id))
          .unique();
        if (!search)
          throw new Error("Cannot restore missing message search text");
        if (message.content !== search.content)
          await ctx.db.patch(message._id, { content: search.content });
      }
    }
    const phase = page.isDone
      ? state.phase === "copying"
        ? "pruning"
        : state.phase === "stripping"
          ? "ready"
          : "legacy"
      : state.phase;
    await ctx.db.patch(state._id, {
      phase,
      cursor: page.isDone ? null : page.continueCursor,
    });
    return {
      phase,
      processed: page.page.length,
      done: phase === "ready" || phase === "legacy",
    };
  },
});
