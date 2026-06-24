import type { GenericDatabaseReader } from "convex/server";
import { ConvexError } from "convex/values";

import type { DataModel, Doc } from "../_generated/dataModel";
import { getSuspensionMessage } from "../../lib/suspensionMessage";

export const CHAT_ACCESS_SUSPENDED_CODE = "CHAT_ACCESS_SUSPENDED";

type SuspensionReaderCtx = {
  db: GenericDatabaseReader<DataModel>;
};

async function getActiveFraudDisputeSuspension(
  ctx: SuspensionReaderCtx,
  userId: string,
): Promise<Doc<"user_suspensions"> | null> {
  const activeSuspensions = await ctx.db
    .query("user_suspensions")
    .withIndex("by_user_status_source_created", (q) =>
      q.eq("user_id", userId).eq("status", "active"),
    )
    .order("desc")
    .collect();

  return (
    activeSuspensions.find(
      (suspension) => suspension.category === "dispute_fraudulent",
    ) ?? null
  );
}

export async function isUserBlockedByActiveFraudDispute(
  ctx: SuspensionReaderCtx,
  userId: string,
): Promise<boolean> {
  return (await getActiveFraudDisputeSuspension(ctx, userId)) !== null;
}

export async function assertUserCanAccessChatHistory(
  ctx: SuspensionReaderCtx,
  userId: string,
): Promise<void> {
  const suspension = await getActiveFraudDisputeSuspension(ctx, userId);
  if (!suspension) return;

  throw new ConvexError({
    code: CHAT_ACCESS_SUSPENDED_CODE,
    message: getSuspensionMessage(
      `${suspension.category}:${suspension.source_id}`,
    ),
    suspensionCategory: suspension.category,
    suspensionSource: suspension.source,
  });
}
