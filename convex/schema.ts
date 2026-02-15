import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  chats: defineTable({
    id: v.string(),
    title: v.string(),
    user_id: v.string(),
    finish_reason: v.optional(v.string()),
    active_stream_id: v.optional(v.string()),
    active_trigger_run_id: v.optional(v.string()),
    canceled_at: v.optional(v.number()),
    default_model_slug: v.optional(
      v.union(v.literal("ask"), v.literal("agent"), v.literal("agent-long")),
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
    // Sharing fields
    share_id: v.optional(v.string()),
    share_date: v.optional(v.number()),
    pinned_at: v.optional(v.number()),
  })
    .index("by_chat_id", ["id"])
    .index("by_user_and_updated", ["user_id", "update_time"])
    .index("by_user_and_pinned", ["user_id", "pinned_at"])
    .index("by_share_id", ["share_id"])
    .searchIndex("search_title", {
      searchField: "title",
      filterFields: ["user_id"],
    }),

  chat_summaries: defineTable({
    chat_id: v.string(),
    summary_text: v.string(),
    summary_up_to_message_id: v.string(),
    previous_summaries: v.optional(
      v.array(
        v.object({
          summary_text: v.string(),
          summary_up_to_message_id: v.string(),
        }),
      ),
    ),
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
    model: v.optional(v.string()),
    generation_time_ms: v.optional(v.number()),
    finish_reason: v.optional(v.string()),
    usage: v.optional(v.any()),
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
    // Legacy field for Convex storage (existing files)
    storage_id: v.optional(v.id("_storage")),
    // New field for S3 storage
    s3_key: v.optional(v.string()),
    user_id: v.string(),
    name: v.string(),
    media_type: v.string(),
    size: v.number(),
    file_token_size: v.number(),
    content: v.optional(v.string()),
    is_attached: v.boolean(),
  })
    .index("by_user_id", ["user_id"])
    .index("by_is_attached", ["is_attached"])
    .index("by_s3_key", ["s3_key"])
    .index("by_storage_id", ["storage_id"]),

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
    guardrails_config: v.optional(v.string()),
    extra_usage_enabled: v.optional(v.boolean()),
  }).index("by_user_id", ["user_id"]),

  // Extra usage (created when user enables extra usage)
  // Note: Most monetary values stored in POINTS for precision (1 point = $0.0001, matching rate limiting)
  // This avoids precision loss when deducting sub-cent amounts from balance.
  // Exception: auto_reload_amount_dollars is stored in dollars since it's used directly for Stripe charges.
  extra_usage: defineTable({
    user_id: v.string(),
    balance_points: v.number(),
    auto_reload_enabled: v.optional(v.boolean()),
    auto_reload_threshold_points: v.optional(v.number()),
    auto_reload_amount_dollars: v.optional(v.number()), // Stored in dollars for Stripe
    monthly_cap_points: v.optional(v.number()),
    monthly_spent_points: v.optional(v.number()),
    monthly_reset_date: v.optional(v.string()),
    updated_at: v.number(),
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

  notes: defineTable({
    user_id: v.string(),
    note_id: v.string(),
    title: v.string(),
    content: v.string(),
    category: v.union(
      v.literal("general"),
      v.literal("findings"),
      v.literal("methodology"),
      v.literal("questions"),
      v.literal("plan"),
    ),
    tags: v.array(v.string()),
    tokens: v.number(),
    updated_at: v.number(),
  })
    .index("by_note_id", ["note_id"])
    .index("by_user_and_category", ["user_id", "category"])
    .index("by_user_and_updated", ["user_id", "updated_at"])
    .searchIndex("search_notes", {
      searchField: "content",
      filterFields: ["user_id", "category"],
    }),

  temp_streams: defineTable({
    chat_id: v.string(),
    user_id: v.string(),
  }).index("by_chat_id", ["chat_id"]),

  // Local Sandbox Tables
  local_sandbox_tokens: defineTable({
    user_id: v.string(),
    token: v.string(),
    token_created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_user_id", ["user_id"])
    .index("by_token", ["token"]),

  local_sandbox_connections: defineTable({
    user_id: v.string(),
    connection_id: v.string(),
    connection_name: v.string(),
    container_id: v.optional(v.string()),
    client_version: v.string(),
    mode: v.union(v.literal("docker"), v.literal("dangerous")),
    os_info: v.optional(
      v.object({
        platform: v.string(),
        arch: v.string(),
        release: v.string(),
        hostname: v.string(),
      }),
    ),
    last_heartbeat: v.number(),
    status: v.union(v.literal("connected"), v.literal("disconnected")),
    created_at: v.number(),
  })
    .index("by_user_id", ["user_id"])
    .index("by_connection_id", ["connection_id"])
    .index("by_user_and_status", ["user_id", "status"])
    .index("by_status_and_last_heartbeat", ["status", "last_heartbeat"])
    .index("by_status_and_created_at", ["status", "created_at"]),

  local_sandbox_commands: defineTable({
    user_id: v.string(),
    connection_id: v.string(),
    command_id: v.string(),
    command: v.string(),
    env: v.optional(v.record(v.string(), v.string())),
    cwd: v.optional(v.string()),
    timeout: v.optional(v.number()),
    background: v.optional(v.boolean()),
    // Optional display name for CLI output (empty string = hide, undefined = show command)
    display_name: v.optional(v.string()),
    status: v.union(
      v.literal("pending"),
      v.literal("executing"),
      v.literal("completed"),
    ),
    created_at: v.number(),
  })
    .index("by_command_id", ["command_id"])
    .index("by_connection_and_status", ["connection_id", "status"])
    .index("by_user_and_status", ["user_id", "status"])
    .index("by_status_and_created_at", ["status", "created_at"]),

  local_sandbox_results: defineTable({
    command_id: v.string(),
    user_id: v.string(),
    stdout: v.string(),
    stderr: v.string(),
    exit_code: v.number(),
    pid: v.optional(v.number()),
    duration: v.number(),
    completed_at: v.number(),
  })
    .index("by_command_id", ["command_id"])
    .index("by_completed_at", ["completed_at"]),

  // Tracks aggregate migration state per user
  // Version 0 (default/missing) = no aggregates migrated
  // Version 1 = file count aggregate available
  user_aggregate_state: defineTable({
    user_id: v.string(),
    version: v.number(),
    updated_at: v.number(),
  }).index("by_user_id", ["user_id"]),

  // Webhook idempotency (prevents double-crediting on Stripe retries)
  processed_webhooks: defineTable({
    event_id: v.string(),
    processed_at: v.number(),
  }).index("by_event_id", ["event_id"]),
});
