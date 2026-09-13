import type { GenericDatabaseReader } from "convex/server";

import type { DataModel } from "../_generated/dataModel";

export async function isUserDeletionFenced(
  db: GenericDatabaseReader<DataModel>,
  userId: string,
): Promise<boolean> {
  const fence = await db
    .query("user_deletion_fences")
    .withIndex("by_user_id", (q) => q.eq("user_id", userId))
    .first();
  return fence !== null;
}
