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
  }).index("by_user_id", ["user_id"]),

  messages: defineTable({
    id: v.string(),
    chat_id: v.string(),
    role: v.string(),
    parts: v.array(v.any()),
    update_time: v.number(),
  })
    .index("by_message_id", ["id"])
    .index("by_chat_id", ["chat_id"]),
});
