import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { retainedTailValidator } from "./lib/retainedTail";

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
    // Legacy field retained on historical rows. The local-provider feature
    // was removed and nothing reads or writes this anymore — kept in the
    // schema so old rows still pass validation.
    codex_thread_id: v.optional(v.string()),
  })
    .index("by_chat_id", ["id"])
    .index("by_user_and_updated", ["user_id", "update_time"])
    .index("by_user_and_active_trigger_run", [
      "user_id",
      "active_trigger_run_id",
    ])
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
    summary_up_to_message_creation_time: v.optional(v.number()),
    reason: v.optional(v.string()),
    prompt_version: v.optional(v.string()),
    model: v.optional(v.string()),
    status: v.optional(v.string()),
    error: v.optional(v.string()),
    input_tokens: v.optional(v.number()),
    output_tokens: v.optional(v.number()),
    cache_read_tokens: v.optional(v.number()),
    cache_write_tokens: v.optional(v.number()),
    cost: v.optional(v.number()),
    estimated_compacted_input_tokens: v.optional(v.number()),
    transcript_path: v.optional(v.string()),
    retained_tail: v.optional(retainedTailValidator),
    previous_summaries: v.optional(
      v.array(
        v.object({
          summary_text: v.string(),
          summary_up_to_message_id: v.string(),
          summary_up_to_message_creation_time: v.optional(v.number()),
          retained_tail: v.optional(retainedTailValidator),
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
    mode: v.optional(v.union(v.literal("agent"), v.literal("ask"))),
    generation_started_at: v.optional(v.number()),
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
    .index("by_s3_key", ["s3_key"]),

  feedback: defineTable({
    feedback_type: v.union(v.literal("positive"), v.literal("negative")),
    feedback_details: v.optional(v.string()),
  }),

  cancellation_reasons: defineTable({
    user_id: v.string(),
    organization_id: v.optional(v.string()),
    stripe_customer_id: v.optional(v.string()),
    stripe_subscription_id: v.optional(v.string()),
    stripe_price_id: v.optional(v.string()),
    plan: v.optional(v.string()),
    subscription_tier: v.optional(
      v.union(
        v.literal("free"),
        v.literal("pro"),
        v.literal("pro-plus"),
        v.literal("ultra"),
        v.literal("team"),
      ),
    ),
    reason_category: v.union(
      v.literal("too_expensive"),
      v.literal("not_using_enough"),
      v.literal("missing_feature"),
      v.literal("results_not_good_enough"),
      v.literal("too_slow_or_unreliable"),
      v.literal("hit_usage_limits"),
      v.literal("switched_tool"),
      v.literal("temporary_pause"),
      v.literal("other"),
    ),
    reason_details_id: v.optional(v.id("cancellation_reason_details")),
    status: v.union(v.literal("started"), v.literal("completed")),
    source: v.union(v.literal("in_app"), v.literal("billing_portal")),
    started_at: v.number(),
    completed_at: v.optional(v.number()),
    account_created_at: v.optional(v.number()),
    account_age_days: v.optional(v.number()),
    recent_usage_days: v.number(),
    recent_usage_request_count: v.number(),
    recent_usage_cost_dollars: v.number(),
    recent_usage_total_tokens: v.number(),
    recent_usage_segment: v.union(
      v.literal("none"),
      v.literal("light"),
      v.literal("moderate"),
      v.literal("heavy"),
    ),
    stripe_cancellation_reason: v.optional(v.string()),
    cancel_at_period_end: v.optional(v.boolean()),
    updated_at: v.number(),
  })
    .index("by_user_started", ["user_id", "started_at"])
    .index("by_org_started", ["organization_id", "started_at"])
    .index("by_stripe_subscription_id", ["stripe_subscription_id"])
    .index("by_stripe_customer_id", ["stripe_customer_id"])
    .index("by_tier_started", ["subscription_tier", "started_at"])
    .index("by_started_at", ["started_at"])
    .index("by_status_started", ["status", "started_at"]),

  cancellation_reason_details: defineTable({
    cancellation_reason_id: v.id("cancellation_reasons"),
    user_id: v.string(),
    organization_id: v.optional(v.string()),
    stripe_subscription_id: v.optional(v.string()),
    reason_details: v.string(),
    created_at: v.number(),
  })
    .index("by_cancellation_reason_id", ["cancellation_reason_id"])
    .index("by_created_at", ["created_at"])
    .index("by_user_id_and_created_at", ["user_id", "created_at"])
    .index("by_stripe_subscription_id_and_created_at", [
      "stripe_subscription_id",
      "created_at",
    ]),

  user_customization: defineTable({
    user_id: v.string(),
    nickname: v.optional(v.string()),
    occupation: v.optional(v.string()),
    personality: v.optional(v.string()),
    traits: v.optional(v.string()),
    additional_info: v.optional(v.string()),
    updated_at: v.number(),
    include_notes: v.optional(v.boolean()),
    // Legacy preference retained on historical rows so old documents still
    // pass validation. New code writes include_notes and uses this only as a
    // fallback when returning older customization rows.
    include_memory_entries: v.optional(v.boolean()),
    guardrails_config: v.optional(v.string()),
    caido_enabled: v.optional(v.boolean()),
    caido_port: v.optional(v.number()),
    extra_usage_enabled: v.optional(v.boolean()),
    // Legacy MAX Mode flag retained on historical rows. The feature was
    // removed and nothing reads or writes this anymore — kept in the schema
    // so old rows still pass validation.
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
    // Legacy trust-cap fields retained so old rows still pass validation.
    // The trust-cap feature no longer reads or writes these values.
    first_successful_charge_at: v.optional(v.number()),
    cumulative_spend_dollars: v.optional(v.number()),
    override_monthly_cap_dollars: v.optional(v.number()),
    // Auto-reload health tracking — disable after consecutive failures so a
    // broken saved card does not keep retrying.
    auto_reload_consecutive_failures: v.optional(v.number()),
    auto_reload_disabled_reason: v.optional(v.string()),
    updated_at: v.number(),
  }).index("by_user_id", ["user_id"]),

  // Team-shared extra usage pool. Admin funds it; any member of the org draws
  // from it for overflow once the team subscription bucket is exhausted.
  // Same units as extra_usage (points; auto-reload amount in dollars).
  team_extra_usage: defineTable({
    organization_id: v.string(),
    enabled: v.optional(v.boolean()),
    balance_points: v.number(),
    auto_reload_enabled: v.optional(v.boolean()),
    auto_reload_threshold_points: v.optional(v.number()),
    auto_reload_amount_dollars: v.optional(v.number()),
    monthly_cap_points: v.optional(v.number()),
    monthly_spent_points: v.optional(v.number()),
    monthly_reset_date: v.optional(v.string()),
    // Legacy trust-cap fields retained so old rows still pass validation.
    // The trust-cap feature no longer reads or writes these values.
    first_successful_charge_at: v.optional(v.number()),
    cumulative_spend_dollars: v.optional(v.number()),
    override_monthly_cap_dollars: v.optional(v.number()),
    auto_reload_consecutive_failures: v.optional(v.number()),
    auto_reload_disabled_reason: v.optional(v.string()),
    updated_at: v.number(),
  }).index("by_org", ["organization_id"]),

  // Per-member usage tracking and admin-set limits within the team pool.
  // monthly_limit_points = null means no per-member cap (only team cap applies).
  // disabled = true blocks the member entirely from drawing on the team pool.
  team_member_usage: defineTable({
    organization_id: v.string(),
    user_id: v.string(),
    monthly_limit_points: v.optional(v.number()),
    monthly_spent_points: v.optional(v.number()),
    monthly_reset_date: v.optional(v.string()),
    disabled: v.optional(v.boolean()),
    updated_at: v.number(),
  })
    .index("by_org", ["organization_id"])
    .index("by_org_user", ["organization_id", "user_id"])
    .index("by_user_id", ["user_id"]),

  referral_codes: defineTable({
    user_id: v.string(),
    code: v.string(),
    status: v.union(v.literal("active"), v.literal("deactivated")),
    referrer_subscription_tier: v.optional(
      v.union(
        v.literal("free"),
        v.literal("pro"),
        v.literal("pro-plus"),
        v.literal("ultra"),
        v.literal("team"),
      ),
    ),
    referrer_organization_id: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
    deactivated_at: v.optional(v.number()),
    deactivated_reason: v.optional(v.string()),
  })
    .index("by_user_id", ["user_id"])
    .index("by_code", ["code"]),

  referral_attributions: defineTable({
    referred_user_id: v.string(),
    referred_identity_hash: v.optional(v.string()),
    referrer_user_id: v.string(),
    referral_code: v.string(),
    referrer_subscription_tier: v.optional(
      v.union(
        v.literal("free"),
        v.literal("pro"),
        v.literal("pro-plus"),
        v.literal("ultra"),
        v.literal("team"),
      ),
    ),
    referrer_organization_id: v.optional(v.string()),
    status: v.union(v.literal("attributed"), v.literal("converted")),
    signup_bonus_units: v.optional(v.number()),
    sign_up_reward_status: v.union(
      v.literal("none"),
      v.literal("awarded"),
      v.literal("withheld"),
    ),
    conversion_reward_status: v.union(
      v.literal("pending"),
      v.literal("awarded"),
      v.literal("withheld"),
    ),
    source: v.optional(v.string()),
    stripe_checkout_session_id: v.optional(v.string()),
    stripe_customer_id: v.optional(v.string()),
    stripe_subscription_id: v.optional(v.string()),
    stripe_invoice_id: v.optional(v.string()),
    requested_plan: v.optional(v.string()),
    converted_tier: v.optional(
      v.union(
        v.literal("pro"),
        v.literal("pro-plus"),
        v.literal("ultra"),
        v.literal("team"),
      ),
    ),
    created_at: v.number(),
    updated_at: v.number(),
    converted_at: v.optional(v.number()),
    withheld_reason: v.optional(v.string()),
  })
    .index("by_referred_user_id", ["referred_user_id"])
    .index("by_referrer_user_id", ["referrer_user_id"])
    .index("by_referred_identity_hash", ["referred_identity_hash"])
    .index("by_referral_code", ["referral_code"])
    .index("by_stripe_checkout_session_id", ["stripe_checkout_session_id"])
    .index("by_stripe_customer_id", ["stripe_customer_id"])
    .index("by_stripe_subscription_id", ["stripe_subscription_id"]),

  referral_rewards: defineTable({
    idempotency_key: v.string(),
    reward_type: v.union(
      v.literal("referred_signup"),
      v.literal("referrer_conversion"),
    ),
    status: v.union(v.literal("awarded"), v.literal("withheld")),
    user_id: v.optional(v.string()),
    referrer_user_id: v.optional(v.string()),
    referred_user_id: v.optional(v.string()),
    referral_code: v.optional(v.string()),
    amount_dollars: v.number(),
    amount_units: v.optional(v.number()),
    reason: v.optional(v.string()),
    stripe_checkout_session_id: v.optional(v.string()),
    stripe_customer_id: v.optional(v.string()),
    stripe_subscription_id: v.optional(v.string()),
    stripe_invoice_id: v.optional(v.string()),
    created_at: v.number(),
    notification_seen_at: v.optional(v.number()),
  })
    .index("by_idempotency_key", ["idempotency_key"])
    .index("by_user_id", ["user_id"])
    .index("by_referrer_user_id", ["referrer_user_id"])
    .index("by_referrer_notification", [
      "referrer_user_id",
      "reward_type",
      "status",
      "notification_seen_at",
      "created_at",
    ])
    .index("by_referred_user_id", ["referred_user_id"]),

  account_identities: defineTable({
    identity_hash: v.string(),
    first_seen_at: v.number(),
    last_seen_at: v.number(),
    latest_user_id: v.string(),
    deleted_at: v.optional(v.number()),
  })
    .index("by_identity_hash", ["identity_hash"])
    .index("by_latest_user_id", ["latest_user_id"]),

  user_suspensions: defineTable({
    user_id: v.string(),
    status: v.union(v.literal("active"), v.literal("resolved")),
    category: v.union(
      v.literal("early_fraud_warning"),
      v.literal("dispute_fraudulent"),
      v.literal("dispute_billing_hold"),
    ),
    source: v.literal("stripe"),
    source_id: v.string(),
    source_reason: v.optional(v.string()),
    stripe_customer_id: v.string(),
    stripe_charge_id: v.optional(v.string()),
    workos_organization_id: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
    source_created_at: v.optional(v.number()),
    resolved_at: v.optional(v.number()),
    resolved_reason: v.optional(v.string()),
  })
    .index("by_user_id", ["user_id"])
    .index("by_user_and_status", ["user_id", "status"])
    .index("by_user_status_source_created", [
      "user_id",
      "status",
      "source_created_at",
    ])
    .index("by_user_status_category_source_created", [
      "user_id",
      "status",
      "category",
      "source_created_at",
    ])
    .index("by_user_and_source", ["user_id", "source_id"])
    .index("by_customer_and_status", ["stripe_customer_id", "status"]),

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
  })
    .index("by_chat_id", ["chat_id"])
    .index("by_user_id", ["user_id"]),

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
    capabilities: v.optional(
      v.object({
        commands: v.boolean(),
        pty: v.boolean(),
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
    organization_id: v.optional(v.string()),
    chat_id: v.optional(v.string()),
    endpoint: v.optional(
      v.union(v.literal("/api/chat"), v.literal("/api/agent-long")),
    ),
    mode: v.optional(v.union(v.literal("ask"), v.literal("agent"))),
    subscription: v.optional(v.string()),
    model: v.string(),
    type: v.union(
      v.literal("included"),
      v.literal("extra"),
      v.literal("mixed"),
    ),
    input_tokens: v.number(),
    output_tokens: v.number(),
    cache_read_tokens: v.optional(v.number()),
    cache_write_tokens: v.optional(v.number()),
    total_tokens: v.number(),
    cost_dollars: v.number(),
    included_cost_dollars: v.optional(v.number()),
    extra_usage_cost_dollars: v.optional(v.number()),
    included_points_deducted: v.optional(v.number()),
    extra_usage_points_deducted: v.optional(v.number()),
    model_cost_dollars: v.optional(v.number()),
    non_model_cost_dollars: v.optional(v.number()),
    cost_source: v.optional(
      v.union(
        v.literal("provider"),
        v.literal("token_estimate"),
        v.literal("raw_token_estimate"),
      ),
    ),
    // Legacy MAX Mode flag retained on historical rows. The feature was
    // removed and nothing reads or writes this anymore — kept in the schema
    // so old rows still pass validation.
    max_mode: v.optional(v.boolean()),
    // Legacy BYOK flag retained on historical rows. The feature was removed
    // and nothing reads or writes this anymore — kept in the schema so old
    // rows still pass validation.
    byok: v.optional(v.boolean()),
  })
    .index("by_user", ["user_id"])
    .index("by_user_and_model", ["user_id", "model"])
    .index("by_org", ["organization_id"]),

  // Durable revenue ledger for unit economics reporting. Revenue is stored as
  // gross/net dollars because usage costs are sub-cent dollar values already.
  revenue_events: defineTable({
    entity_type: v.union(v.literal("user"), v.literal("organization")),
    entity_id: v.string(),
    user_id: v.optional(v.string()),
    organization_id: v.optional(v.string()),
    source: v.union(
      v.literal("subscription"),
      v.literal("extra_usage"),
      v.literal("team_extra_usage"),
      v.literal("manual_adjustment"),
    ),
    source_event_id: v.string(),
    idempotency_key: v.string(),
    gross_revenue_dollars: v.number(),
    net_revenue_dollars: v.number(),
    // Normalized monthly recurring revenue for subscription invoices. Raw
    // cash collected remains in gross/net revenue.
    mrr_dollars: v.optional(v.number()),
    currency: v.string(),
    occurred_at: v.number(),
    attribution_strategy: v.union(
      v.literal("direct"),
      v.literal("split_evenly"),
      v.literal("organization_pool"),
    ),
    stripe_customer_id: v.optional(v.string()),
    stripe_subscription_id: v.optional(v.string()),
    stripe_invoice_id: v.optional(v.string()),
    stripe_checkout_session_id: v.optional(v.string()),
    stripe_payment_intent_id: v.optional(v.string()),
    stripe_price_id: v.optional(v.string()),
    plan: v.optional(v.string()),
    quantity: v.optional(v.number()),
    user_count: v.optional(v.number()),
    description: v.optional(v.string()),
    created_at: v.number(),
  })
    .index("by_idempotency_key", ["idempotency_key"])
    .index("by_entity_occurred", ["entity_type", "entity_id", "occurred_at"])
    .index("by_user_occurred", ["user_id", "occurred_at"])
    .index("by_org_occurred", ["organization_id", "occurred_at"])
    .index("by_source_event", ["source", "source_event_id"]),

  // Append-only paid-start ledger for funnel health. One row is recorded per
  // new paid account/subscription; user and seat counts are separate fields so
  // team starts do not silently inflate account conversion volume.
  paid_start_events: defineTable({
    entity_type: v.union(v.literal("user"), v.literal("organization")),
    entity_id: v.string(),
    user_id: v.optional(v.string()),
    organization_id: v.optional(v.string()),
    source_event_id: v.string(),
    idempotency_key: v.string(),
    occurred_at: v.number(),
    day: v.string(),
    conversion_type: v.union(
      v.literal("free_to_paid"),
      v.literal("paid_subscription_start"),
    ),
    tier: v.union(
      v.literal("pro"),
      v.literal("pro-plus"),
      v.literal("ultra"),
      v.literal("team"),
    ),
    plan: v.optional(v.string()),
    paid_account_start_count: v.number(),
    paid_user_start_count: v.number(),
    paid_seat_count: v.number(),
    billing_interval: v.optional(
      v.union(
        v.literal("day"),
        v.literal("week"),
        v.literal("month"),
        v.literal("year"),
      ),
    ),
    billing_interval_count: v.optional(v.number()),
    quantity: v.optional(v.number()),
    user_count: v.optional(v.number()),
    stripe_customer_id: v.optional(v.string()),
    stripe_subscription_id: v.optional(v.string()),
    stripe_invoice_id: v.optional(v.string()),
    stripe_price_id: v.optional(v.string()),
    created_at: v.number(),
  })
    .index("by_idempotency_key", ["idempotency_key"])
    .index("by_entity_day", ["entity_type", "entity_id", "day"])
    .index("by_day", ["day"])
    .index("by_user_day", ["user_id", "day"])
    .index("by_org_day", ["organization_id", "day"])
    .index("by_tier_day", ["tier", "day"])
    .index("by_source_event", ["source_event_id"]),

  // Compact daily paid-start mix for dashboarding/PostHog warehouse sync.
  // Counts only; join to revenue_events only when explicitly analyzing money.
  paid_start_mix_daily: defineTable({
    day: v.string(),
    tier: v.union(
      v.literal("pro"),
      v.literal("pro-plus"),
      v.literal("ultra"),
      v.literal("team"),
    ),
    plan: v.string(),
    billing_interval: v.union(
      v.literal("day"),
      v.literal("week"),
      v.literal("month"),
      v.literal("year"),
      v.literal("unknown"),
    ),
    paid_account_start_count: v.number(),
    paid_user_start_count: v.number(),
    paid_seat_count: v.number(),
    updated_at: v.number(),
  })
    .index("by_segment", ["day", "tier", "billing_interval", "plan"])
    .index("by_day", ["day"])
    .index("by_tier_day", ["tier", "day"])
    .index("by_interval_day", ["billing_interval", "day"])
    .index("by_tier_interval_day", ["tier", "billing_interval", "day"]),

  // Compact daily rows intended for dashboarding and PostHog warehouse sync.
  // Query either entity_type=user for per-user profitability or
  // entity_type=organization for team pool/subscription reporting.
  unit_economics_daily: defineTable({
    entity_type: v.union(v.literal("user"), v.literal("organization")),
    entity_id: v.string(),
    user_id: v.optional(v.string()),
    organization_id: v.optional(v.string()),
    day: v.string(),
    gross_revenue_dollars: v.number(),
    net_revenue_dollars: v.number(),
    mrr_dollars: v.optional(v.number()),
    model_cost_dollars: v.number(),
    non_model_cost_dollars: v.number(),
    total_cost_dollars: v.number(),
    gross_profit_dollars: v.number(),
    included_usage_cost_dollars: v.number(),
    extra_usage_cost_dollars: v.number(),
    usage_request_count: v.number(),
    revenue_event_count: v.number(),
    input_tokens: v.number(),
    output_tokens: v.number(),
    cache_read_tokens: v.number(),
    cache_write_tokens: v.number(),
    total_tokens: v.number(),
    updated_at: v.number(),
  })
    .index("by_entity_day", ["entity_type", "entity_id", "day"])
    .index("by_day", ["day"])
    .index("by_type_day", ["entity_type", "day"])
    .index("by_user_day", ["user_id", "day"])
    .index("by_org_day", ["organization_id", "day"]),

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

  // Durable idempotency records for user-visible checkout session confirms.
  // Unlike webhook retry deduplication, these keys must not be time-purged
  // because a paid Checkout Session ID can be replayed by the purchaser.
  processed_checkout_sessions: defineTable({
    session_key: v.string(),
    processed_at: v.number(),
  }).index("by_session_key", ["session_key"]),
});
