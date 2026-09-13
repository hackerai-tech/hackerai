import { internal } from "../_generated/api";
import type { MutationCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";

// Keep a receipt until object storage confirms deletion. Removing a file row
// or scheduling a job alone is not evidence that its content has been deleted.
export async function scheduleFileDeletion(
  ctx: MutationCtx,
  file: Doc<"files">,
  chatId?: string,
) {
  if (!file.s3_key) return;
  const id = await ctx.db.insert("pendingFileDeletions", {
    user_id: file.user_id,
    chat_id: chatId,
    file_id: file._id,
    s3_key: file.s3_key,
    s3_region: file.s3_region,
    s3_bucket: file.s3_bucket,
  });
  const scheduledFunctionId = await ctx.scheduler.runAfter(
    0,
    internal.s3Cleanup.deleteTrackedS3Object,
    { deletionId: id },
  );
  await ctx.db.patch(id, { scheduled_function_id: scheduledFunctionId });
}
