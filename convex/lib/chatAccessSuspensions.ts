import type { GenericDatabaseReader } from "convex/server";

import type { DataModel, Doc } from "../_generated/dataModel";

export const CHAT_ACCESS_BLOCKING_SUSPENSION_CATEGORIES = [
  "dispute_fraudulent",
  "support_confirmed_fraud",
] as const;

type SuspensionReaderCtx = {
  db: GenericDatabaseReader<DataModel>;
};

const suspensionTimestamp = (suspension: Doc<"user_suspensions">) =>
  suspension.source_created_at ?? suspension.created_at;

export async function getActiveChatAccessBlockingSuspension(
  ctx: SuspensionReaderCtx,
  userId: string,
): Promise<Doc<"user_suspensions"> | null> {
  let newest: Doc<"user_suspensions"> | null = null;

  for (const category of CHAT_ACCESS_BLOCKING_SUSPENSION_CATEGORIES) {
    const candidate = await ctx.db
      .query("user_suspensions")
      .withIndex("by_user_status_category_source_created", (q) =>
        q.eq("user_id", userId).eq("status", "active").eq("category", category),
      )
      .order("desc")
      .first();

    if (
      candidate &&
      (!newest || suspensionTimestamp(candidate) > suspensionTimestamp(newest))
    ) {
      newest = candidate;
    }
  }

  return newest;
}
