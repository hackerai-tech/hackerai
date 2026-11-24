import { v } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { QueuedMessageSettings } from "../../lib/chat/queued-message";

/** See QueuedMessageSettings in lib/chat/queued-message.ts. */
export const queuedMessageSettingsValidator = v.object({
  agentPermissionMode: v.union(
    v.literal("full_access"),
    v.literal("auto_review"),
    v.literal("ask_approval"),
  ),
  sandboxPreference: v.optional(v.string()),
  selectedModel: v.optional(v.string()),
});

/**
 * One row per user, so a settings change reaches every waiting message in a
 * single write and a server send reads the latest choice. No row means no
 * unattended send.
 */
export const getQueuedMessageSettings = async (
  ctx: QueryCtx | MutationCtx,
  userId: string,
): Promise<QueuedMessageSettings | null> =>
  (
    await ctx.db
      .query("agent_queue_settings")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .first()
  )?.settings ?? null;

export async function saveQueuedMessageSettings(
  ctx: MutationCtx,
  userId: string,
  settings: QueuedMessageSettings,
) {
  const row = await ctx.db
    .query("agent_queue_settings")
    .withIndex("by_user_id", (q) => q.eq("user_id", userId))
    .first();
  if (row) await ctx.db.patch(row._id, { settings, updated_at: Date.now() });
  else
    await ctx.db.insert("agent_queue_settings", {
      user_id: userId,
      settings,
      updated_at: Date.now(),
    });
}
