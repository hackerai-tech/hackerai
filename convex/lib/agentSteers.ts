import type { MutationCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { isAgentSteerPart } from "../../lib/chat/agent-steer";

// Settled rows stay briefly as tombstones: a worker that was stopped can still
// save a response after the client withdrew one of its steers.
export const AGENT_STEER_SCAN_LIMIT = 100;
export const AGENT_STEER_TOMBSTONE_TTL_MS = 60 * 60 * 1000;

export const isOpenSteer = (row: Doc<"agent_steers">) =>
  row.settled_at === undefined;

export async function settleSteer(
  ctx: MutationCtx,
  row: Doc<"agent_steers">,
  as: "saved" | "withdrawn",
) {
  const now = Date.now();
  await ctx.db.patch(row._id, {
    [as === "saved" ? "saved_at" : "withdrawn_at"]: now,
    settled_at: now,
  });
}

/**
 * Chat deletion removes steers with the rest of the chat's content. True
 * when the batch was full, so the caller deletes again before the chat row.
 */
export async function deleteAgentSteersForChat(
  ctx: MutationCtx,
  chatId: string,
): Promise<boolean> {
  const rows = await ctx.db
    .query("agent_steers")
    .withIndex("by_chat_id", (q) => q.eq("chat_id", chatId))
    .take(AGENT_STEER_SCAN_LIMIT);
  for (const row of rows) await ctx.db.delete(row._id);
  return rows.length === AGENT_STEER_SCAN_LIMIT;
}

async function findSteerRow(
  ctx: MutationCtx,
  args: { chatId: string; userId: string },
  steerId: string,
) {
  const row = await ctx.db
    .query("agent_steers")
    .withIndex("by_steer_id", (q) => q.eq("id", steerId))
    .first();
  return row && row.chat_id === args.chatId && row.user_id === args.userId
    ? row
    : null;
}

/**
 * Before a response is written: a steer the client already withdrew is going
 * back to the queue, so the saved response must not also show it.
 */
export async function withoutWithdrawnSteers(
  ctx: MutationCtx,
  args: { chatId: string; userId: string; parts: unknown[] },
): Promise<unknown[]> {
  if (!args.parts.some(isAgentSteerPart)) return args.parts;
  const kept: unknown[] = [];
  for (const part of args.parts) {
    if (isAgentSteerPart(part)) {
      const row = await findSteerRow(ctx, args, part.data.id);
      if (row?.withdrawn_at !== undefined) continue;
    }
    kept.push(part);
  }
  return kept;
}

/**
 * After a response is written, in the same transaction: each steer it shows
 * is settled as saved, so the client never withdraws and resends it. An open
 * row therefore always means the steer is in no saved response.
 */
export async function retireSavedSteers(
  ctx: MutationCtx,
  args: { chatId: string; userId: string; parts: unknown[] },
) {
  for (const part of args.parts) {
    if (!isAgentSteerPart(part)) continue;
    const row = await findSteerRow(ctx, args, part.data.id);
    if (row && isOpenSteer(row)) await settleSteer(ctx, row, "saved");
  }
}
