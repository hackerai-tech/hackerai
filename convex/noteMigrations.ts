import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internalMutation } from "./lib/serviceFunctions";
import { buildNoteSearchMetadata } from "../lib/notes/policy";

/**
 * Explicit, bounded backfill of `search_metadata` for notes written before
 * metadata search existed. Internal (admin-key) only and never scheduled:
 * an operator runs one page at a time with the returned cursor until done.
 * Idempotent, and it never touches edit or observation timestamps.
 */
export const backfillNoteSearchMetadata = internalMutation({
  args: { paginationOpts: paginationOptsValidator },
  returns: v.object({
    isDone: v.boolean(),
    continueCursor: v.string(),
    scanned: v.number(),
    updated: v.number(),
  }),
  handler: async (ctx, args) => {
    const page = await ctx.db.query("notes").paginate({
      ...args.paginationOpts,
      numItems: Math.min(100, Math.max(1, args.paginationOpts.numItems)),
      maximumBytesRead: 4 * 1024 * 1024,
    });
    let updated = 0;
    for (const note of page.page) {
      const searchMetadata = buildNoteSearchMetadata(note);
      if (note.search_metadata === searchMetadata) continue;
      await ctx.db.patch(note._id, { search_metadata: searchMetadata });
      updated++;
    }
    return {
      isDone: page.isDone,
      continueCursor: page.continueCursor,
      scanned: page.page.length,
      updated,
    };
  },
});
