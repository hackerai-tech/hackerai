import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  chats: defineTable({
    id: v.string(),
    title: v.string(),
    user_id: v.string(),
    finish_reason: v.optional(v.string()),
    todos: v.optional(
      v.array(
        v.object({
          id: v.string(),
          content: v.string(),
          status: v.union(
            v.literal("pending"),
            v.literal("in_progress"),
            v.literal("completed"),
            v.literal("cancelled"),
          ),
        }),
      ),
    ),
    update_time: v.number(),
  })
    .index("by_chat_id", ["id"])
    .index("by_user_and_updated", ["user_id", "update_time"]),

  messages: defineTable({
    id: v.string(),
    chat_id: v.string(),
    role: v.string(),
    parts: v.array(v.any()),
    storage_ids: v.optional(v.array(v.id("_storage"))), // Track uploaded file storage IDs for cleanup
    update_time: v.number(),
  })
    .index("by_message_id", ["id"])
    .index("by_chat_id", ["chat_id"]),
});
