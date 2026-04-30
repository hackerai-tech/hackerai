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
    sandbox_type: v.optional(v.string()),
    selected_model: v.optional(v.string()),
    codex_thread_id: v.optional(v.string()),
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
    is_hidden: v.optional(v.boolean()),
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
    caido_enabled: v.optional(v.boolean()),
    caido_port: v.optional(v.number()),
    extra_usage_enabled: v.optional(v.boolean()),
    max_mode_enabled: v.optional(v.boolean()),
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
    // Trust-based spending cap fields
    first_successful_charge_at: v.optional(v.number()), // Timestamp of first successful charge
    cumulative_spend_dollars: v.optional(v.number()), // Total of all successful charges
    override_monthly_cap_dollars: v.optional(v.number()), // Manual override set by support team
    // Auto-reload health tracking — disable after consecutive failures so a
    // broken saved card does not keep retrying.
    auto_reload_consecutive_failures: v.optional(v.number()),
    auto_reload_disabled_reason: v.optional(v.string()),
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
    // Set whenever status flips to "disconnected" so refresh-time errors can
    // report the cause (presence sweep, token regen, desktop kick, etc.) and
    // the lag between disconnect and the failed refresh attempt.
    disconnected_at: v.optional(v.number()),
    disconnect_reason: v.optional(
      v.union(
        v.literal("client_disconnect"),
        v.literal("desktop_disconnect"),
        v.literal("desktop_kicked_by_new_session"),
        v.literal("token_regenerated"),
        v.literal("presence_sweep"),
      ),
    ),
  })
    .index("by_user_id", ["user_id"])
    .index("by_connection_id", ["connection_id"])
    .index("by_user_and_status", ["user_id", "status"])
    .index("by_status_and_created_at", ["status", "created_at"]),

  // Per-request usage logs for the usage dashboard
  usage_logs: defineTable({
    user_id: v.string(),
    model: v.string(),
    type: v.union(v.literal("included"), v.literal("extra")),
    input_tokens: v.number(),
    output_tokens: v.number(),
    cache_read_tokens: v.optional(v.number()),
    cache_write_tokens: v.optional(v.number()),
    total_tokens: v.number(),
    cost_dollars: v.number(),
    // True when Max mode was active for this request (larger context window).
    max_mode: v.optional(v.boolean()),
    // Legacy BYOK flag retained on historical rows. The feature was removed
    // and nothing reads or writes this anymore — kept in the schema so old
    // rows still pass validation.
    byok: v.optional(v.boolean()),
  })
    .index("by_user", ["user_id"])
    .index("by_user_and_model", ["user_id", "model"]),

  // Webhook idempotency (prevents double-crediting on Stripe retries)
  processed_webhooks: defineTable({
    event_id: v.string(),
    processed_at: v.number(),
    // State-machine fields for atomic claim/finalize. Optional for
    // backwards compatibility — legacy rows (no status) are treated as
    // completed since they were inserted under the old "mark on entry"
    // semantics for events whose lifecycle has already concluded.
    status: v.optional(v.union(v.literal("pending"), v.literal("completed"))),
    claimed_at: v.optional(v.number()),
  }).index("by_event_id", ["event_id"]),
});
