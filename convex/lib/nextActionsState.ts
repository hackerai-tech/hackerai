import { v } from "convex/values";

export const nextActionsBatchValidator = v.object({
  batchId: v.string(),
  messageId: v.string(),
  mode: v.union(v.literal("ask"), v.literal("agent")),
  suggestions: v.array(v.string()),
  validationVersion: v.optional(v.number()),
});

// One bounded private record per chat; deleting the chat deletes its prediction.
export const nextActionsStateValidator = v.object({
  messageId: v.string(),
  finishedAt: v.number(),
  consumed: v.boolean(),
  batch: v.optional(nextActionsBatchValidator),
});
