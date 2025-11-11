import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  chats: defineTable({
    id: v.string(),
    title: v.string(),
    user_id: v.string(),
    finish_reason: v.optional(v.string()),
    active_stream_id: v.optional(v.string()),
    canceled_at: v.optional(v.number()),
    default_model_slug: v.optional(
      v.union(v.literal("ask"), v.literal("agent")),
    ),
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
          sourceMessageId: v.optional(v.string()),
        }),
      ),
    ),
    branched_from_chat_id: v.optional(v.string()),
    latest_summary_id: v.optional(v.id("chat_summaries")),
    update_time: v.number(),
  })
    .index("by_chat_id", ["id"])
    .index("by_user_and_updated", ["user_id", "update_time"])
    .searchIndex("search_title", {
      searchField: "title",
      filterFields: ["user_id"],
    }),

  chat_summaries: defineTable({
    chat_id: v.string(),
    summary_text: v.string(),
    summary_up_to_message_id: v.string(),
  }).index("by_chat_id", ["chat_id"]),

  messages: defineTable({
    id: v.string(),
    chat_id: v.string(),
    user_id: v.string(),
    role: v.union(
      v.literal("user"),
      v.literal("assistant"),
      v.literal("system"),
    ),
    parts: v.array(v.any()),
    content: v.optional(v.string()),
    file_ids: v.optional(v.array(v.id("files"))),
    feedback_id: v.optional(v.id("feedback")),
    source_message_id: v.optional(v.string()),
    update_time: v.number(),
  })
    .index("by_message_id", ["id"])
    .index("by_chat_id", ["chat_id"])
    .index("by_feedback_id", ["feedback_id"])
    .index("by_user_id", ["user_id"])
    .searchIndex("search_content", {
      searchField: "content",
      filterFields: ["user_id"],
    }),

  files: defineTable({
    storage_id: v.optional(v.id("_storage")), // Legacy: Convex storage
    s3_key: v.optional(v.string()), // New: S3 storage key
    user_id: v.string(),
    name: v.string(),
    media_type: v.string(),
    size: v.number(),
    file_token_size: v.number(),
    content: v.optional(v.string()),
    is_attached: v.boolean(),
  })
    .index("by_user_id", ["user_id"])
    .index("by_is_attached", ["is_attached"]),

  feedback: defineTable({
    feedback_type: v.union(v.literal("positive"), v.literal("negative")),
    feedback_details: v.optional(v.string()),
  }),

  user_customization: defineTable({
    user_id: v.string(),
    nickname: v.optional(v.string()),
    occupation: v.optional(v.string()),
    personality: v.optional(v.string()),
    traits: v.optional(v.string()),
    additional_info: v.optional(v.string()),
    updated_at: v.number(),
    include_memory_entries: v.optional(v.boolean()),
  }).index("by_user_id", ["user_id"]),

  memories: defineTable({
    user_id: v.string(),
    memory_id: v.string(),
    content: v.string(),
    update_time: v.number(),
    tokens: v.number(),
  })
    .index("by_memory_id", ["memory_id"])
    .index("by_user_and_update_time", ["user_id", "update_time"]),

  temp_streams: defineTable({
    chat_id: v.string(),
    user_id: v.string(),
  }).index("by_chat_id", ["chat_id"]),
});
