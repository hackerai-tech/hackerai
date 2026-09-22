import { ConvexError, v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  query,
  type QueryCtx,
} from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { validateServiceKey } from "./lib/utils";

export const getPendingFile = internalQuery({
  args: { deletionId: v.id("pendingFileDeletions") },
  returns: v.union(
    v.object({
      s3Key: v.string(),
      s3Region: v.optional(v.string()),
      s3Bucket: v.optional(v.string()),
    }),
    v.null(),
  ),
  handler: async (ctx, { deletionId }) => {
    const deletion = await ctx.db.get(deletionId);
    return deletion
      ? {
          s3Key: deletion.s3_key,
          s3Region: deletion.s3_region,
          s3Bucket: deletion.s3_bucket,
        }
      : null;
  },
});

export const completeFile = internalMutation({
  args: { deletionId: v.id("pendingFileDeletions") },
  returns: v.null(),
  handler: async (ctx, { deletionId }) => {
    if (await ctx.db.get(deletionId)) await ctx.db.delete(deletionId);
    return null;
  },
});

const scopeArgs = {
  chatId: v.optional(v.string()),
  projectId: v.optional(v.id("projects")),
  fileId: v.optional(v.id("files")),
};
const statusValidator = v.union(
  v.literal("pending"),
  v.literal("complete"),
  v.literal("failed"),
);
type Scope = {
  chatId?: string;
  projectId?: Doc<"projects">["_id"];
  fileId?: Doc<"files">["_id"];
};

async function getStatus(
  ctx: QueryCtx,
  userId: string,
  scope: Scope,
): Promise<"pending" | "complete" | "failed"> {
  if (Object.values(scope).filter((value) => value !== undefined).length > 1)
    throw new Error("Invalid deletion scope");
  if (scope.projectId) {
    const project = await ctx.db.get(scope.projectId);
    if (project && project.user_id !== userId) throw new Error("Forbidden");
    return project ? "pending" : "complete";
  }
  const pendingFile = scope.fileId
    ? await ctx.db
        .query("pendingFileDeletions")
        .withIndex("by_file", (q) => q.eq("file_id", scope.fileId!))
        .first()
    : scope.chatId
      ? await ctx.db
          .query("pendingFileDeletions")
          .withIndex("by_user_chat", (q) =>
            q.eq("user_id", userId).eq("chat_id", scope.chatId),
          )
          .first()
      : await ctx.db
          .query("pendingFileDeletions")
          .withIndex("by_user", (q) => q.eq("user_id", userId))
          .first();
  if (pendingFile) {
    if (pendingFile.user_id !== userId) throw new Error("Forbidden");
    const job = pendingFile.scheduled_function_id
      ? await ctx.db.system.get(pendingFile.scheduled_function_id)
      : null;
    // A completed or missing job with a surviving receipt did not confirm cleanup.
    if (
      !job ||
      job.state.kind === "failed" ||
      job.state.kind === "canceled" ||
      job.state.kind === "success"
    )
      return "failed";
    return "pending";
  }
  const remaining = scope.fileId
    ? await ctx.db.get(scope.fileId)
    : scope.chatId
      ? await ctx.db
          .query("chats")
          .withIndex("by_chat_id", (q) => q.eq("id", scope.chatId!))
          .first()
      : await ctx.db
          .query("chats")
          .withIndex("by_user_and_updated", (q) => q.eq("user_id", userId))
          .first();
  if (remaining && remaining.user_id !== userId) throw new Error("Forbidden");
  return remaining ? "pending" : "complete";
}

export const getStatusForUser = query({
  args: scopeArgs,
  returns: statusValidator,
  handler: async (ctx, scope) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Not authenticated");
    return getStatus(ctx, identity.subject, scope);
  },
});

export const getStatusForBackend = query({
  args: { ...scopeArgs, serviceKey: v.string(), userId: v.string() },
  returns: statusValidator,
  handler: async (ctx, { serviceKey, userId, ...scope }) => {
    validateServiceKey(serviceKey);
    return getStatus(ctx, userId, scope);
  },
});
