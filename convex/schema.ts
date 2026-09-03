import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { retainedTailValidator } from "./lib/retainedTail";
import {
  researchCohortReportValidator,
  researchCoverageValidator,
  researchRunStatusValidator,
  researchUserProfileValidator,
} from "./userResearchValidators";

const usageDeductionFailureReasonValidator = v.union(
  v.literal("extra_usage_unavailable"),
  v.literal("insufficient_funds"),
  v.literal("monthly_cap_exceeded"),
  v.literal("member_cap_exceeded"),
  v.literal("member_disabled"),
  v.literal("pool_disabled"),
  v.literal("auto_reload_failed"),
  v.literal("deduction_failed"),
);

const activeAgentApprovalRequestValidator = v.object({
  approvalId: v.string(),
  toolCallId: v.string(),
  operation: v.optional(
    v.union(
      v.literal("terminal_execute"),
      v.literal("terminal_interact"),
      v.literal("file_write"),
      v.literal("file_append"),
      v.literal("file_edit"),
    ),
  ),
  target: v.optional(v.string()),
  justification: v.optional(v.string()),
  prefixRule: v.optional(v.array(v.string())),
  title: v.optional(v.string()),
  detail: v.optional(v.string()),
  kind: v.optional(v.union(v.literal("terminal"), v.literal("file"))),
  createdAt: v.optional(v.number()),
  autoReview: v.optional(
    v.object({
      verdict: v.union(
        v.literal("approve"),
        v.literal("ask_user"),
        v.literal("deny"),
      ),
      riskCategory: v.union(
        v.literal("routine"),
        v.literal("destructive"),
        v.literal("credential_access"),
        v.literal("data_egress"),
        v.literal("security_weakening"),
        v.literal("scope_expansion"),
        v.literal("prompt_injection"),
        v.literal("unknown"),
      ),
      rationale: v.string(),
      rolloutPhase: v.union(v.literal("shadow"), v.literal("enforce")),
      failureClass: v.optional(
        v.union(
          v.literal("timeout"),
          v.literal("provider_error"),
          v.literal("parse_error"),
          v.literal("missing_context"),
          v.literal("context_truncated"),
        ),
      ),
    }),
  ),
});

const agentApprovalTargetGrantValidator = v.union(
  v.object({
    kind: v.literal("terminal_command"),
    targetPrefix: v.string(),
    executable: v.string(),
    argv: v.array(v.string()),
  }),
  v.object({
    kind: v.literal("file_change"),
    targetPrefix: v.string(),
    path: v.string(),
    pathFlavor: v.union(v.literal("posix"), v.literal("windows")),
  }),
);

const subagentStatusValidator = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("finalizing"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("canceled"),
  v.literal("timed_out"),
);

const subagentVerdictValidator = v.union(
  v.literal("confirmed"),
  v.literal("rejected"),
  v.literal("inconclusive"),
);

const validationConfidenceValidator = v.union(
  v.literal("low"),
  v.literal("medium"),
  v.literal("high"),
);

export default defineSchema({
  projects: defineTable({
    user_id: v.string(),
    name: v.string(),
    folder_path: v.optional(v.string()),
    pinned_at: v.optional(v.number()),
    deletion_started_at: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_user_and_created", ["user_id", "created_at"])
    .index("by_user_and_updated", ["user_id", "updated_at"])
    .index("by_user_and_pinned", ["user_id", "pinned_at"]),

  chats: defineTable({
    id: v.string(),
    title: v.string(),
    user_id: v.string(),
    finish_reason: v.optional(v.string()),
    last_run_finished_at: v.optional(v.number()),
    active_stream_id: v.optional(v.string()),
    active_trigger_run_id: v.optional(v.string()),
    active_agent_approval_session_id: v.optional(v.string()),
    active_agent_approval_pending: v.optional(v.boolean()),
    active_agent_approval_request: v.optional(
      activeAgentApprovalRequestValidator,
    ),
    agent_approval_grants: v.optional(
      v.array(agentApprovalTargetGrantValidator),
    ),
    canceled_at: v.optional(v.number()),
    deletion_started_at: v.optional(v.number()),
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
    // Snapshot the source title when another user's shared chat is forked.
    // This avoids reading later source-title changes after sharing is revoked.
    branched_from_title: v.optional(v.string()),
    latest_summary_id: v.optional(v.id("chat_summaries")),
    update_time: v.number(),
    // Sharing fields
    share_id: v.optional(v.string()),
    share_date: v.optional(v.number()),
    pinned_at: v.optional(v.number()),
    sandbox_type: v.optional(v.string()),
    selected_model: v.optional(v.string()),
    project_id: v.optional(v.id("projects")),
    // Legacy field retained on historical rows. The local-provider feature
    // was removed and nothing reads or writes this anymore — kept in the
    // schema so old rows still pass validation.
    codex_thread_id: v.optional(v.string()),
  })
    .index("by_chat_id", ["id"])
    .index("by_user_and_updated", ["user_id", "update_time"])
    .index("by_user_project_and_updated", [
      "user_id",
      "project_id",
      "update_time",
    ])
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
    trigger_run_id: v.optional(v.string()),
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
    s3_region: v.optional(v.string()),
    s3_bucket: v.optional(v.string()),
    user_id: v.string(),
    name: v.string(),
    media_type: v.string(),
    size: v.number(),
    file_token_size: v.number(),
    content: v.optional(v.string()),
    auxiliary_vision_description: v.optional(v.string()),
    auxiliary_vision_model: v.optional(v.string()),
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
    reason_subcategory: v.optional(
      v.union(
        v.literal("too_expensive_low_frequency"),
        v.literal("insufficient_included_usage"),
        v.literal("failed_or_incomplete_task"),
        v.literal("slow_or_disconnected_agent"),
        v.literal("wrong_execution_environment"),
        v.literal("model_quality"),
        v.literal("billing_or_renewal"),
        v.literal("missing_capability"),
        v.literal("other"),
      ),
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

  // Privacy-safe Stripe lifecycle facts for involuntary churn and recovery.
  // User-selected cancellation survey answers and free text intentionally stay
  // in cancellation_reasons / cancellation_reason_details.
  involuntary_churn_events: defineTable({
    idempotency_key: v.string(),
    stripe_event_id: v.string(),
    stripe_event_type: v.union(
      v.literal("invoice.payment_failed"),
      v.literal("invoice.paid"),
      v.literal("customer.subscription.deleted"),
      v.literal("payment_method.attached"),
      v.literal("customer.updated"),
    ),
    user_id: v.string(),
    organization_id: v.optional(v.string()),
    stripe_customer_id: v.string(),
    stripe_subscription_id: v.string(),
    stripe_invoice_id: v.optional(v.string()),
    stripe_payment_intent_id: v.optional(v.string()),
    stripe_charge_id: v.optional(v.string()),
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
    billing_failure_lifecycle: v.optional(
      v.union(
        v.literal("invoice_payment_failed"),
        v.literal("subscription_deleted"),
      ),
    ),
    billing_failure_stage: v.optional(v.string()),
    billing_failure_group: v.optional(v.string()),
    billing_reason: v.optional(v.string()),
    invoice_status: v.optional(v.string()),
    attempt_count: v.optional(v.number()),
    outcome_type: v.optional(v.string()),
    outcome_reason: v.optional(v.string()),
    risk_level: v.optional(v.string()),
    amount_due_dollars: v.optional(v.number()),
    amount_remaining_dollars: v.optional(v.number()),
    currency: v.optional(v.string()),
    recovery_result: v.union(
      v.literal("pending"),
      v.literal("payment_method_updated"),
      v.literal("recovered"),
      v.literal("churned"),
      v.literal("ineligible_payment"),
    ),
    occurred_at: v.number(),
    recorded_at: v.number(),
  })
    .index("by_idempotency_key", ["idempotency_key"])
    .index("by_stripe_event_id", ["stripe_event_id"])
    .index("by_invoice_and_occurred", ["stripe_invoice_id", "occurred_at"])
    .index("by_invoice_user_and_occurred", [
      "stripe_invoice_id",
      "user_id",
      "occurred_at",
    ])
    .index("by_subscription_and_occurred", [
      "stripe_subscription_id",
      "occurred_at",
    ])
    .index("by_user_and_occurred", ["user_id", "occurred_at"])
    .index("by_recovery_result_and_occurred", [
      "recovery_result",
      "occurred_at",
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
    // Legacy HTTP interception preference fields retained on historical rows
    // so old documents still pass validation.
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
    // One durable, entity-scoped auto-reload operation. Parallel billing
    // actions reuse this operation (and its Stripe idempotency keys) instead
    // of creating separate invoices from the same low-balance snapshot.
    auto_reload_operation_id: v.optional(v.string()),
    auto_reload_operation_executor_id: v.optional(v.string()),
    auto_reload_operation_started_at: v.optional(v.number()),
    auto_reload_operation_lease_expires_at: v.optional(v.number()),
    auto_reload_operation_amount_dollars: v.optional(v.number()),
    auto_reload_operation_stripe_invoice_id: v.optional(v.string()),
    // Briefly suppress duplicate card attempts after a definitive decline so
    // parallel Agent steps all observe the same failure.
    auto_reload_retry_after: v.optional(v.number()),
    auto_reload_last_failure_reason: v.optional(v.string()),
    updated_at: v.number(),
  }).index("by_user_id", ["user_id"]),

  // Durable support ledger for personal extra-usage Checkout purchases. This
  // complements processed_checkout_sessions: the processed table is only a
  // dedupe guard, while this row explains the observed purchase lifecycle.
  extra_usage_purchases: defineTable({
    user_id: v.string(),
    amount_dollars: v.number(),
    stripe_checkout_session_id: v.string(),
    stripe_payment_intent_id: v.optional(v.string()),
    stripe_invoice_id: v.optional(v.string()),
    status: v.union(
      v.literal("created"),
      v.literal("paid_seen"),
      v.literal("credited"),
      v.literal("failed"),
    ),
    last_route: v.optional(
      v.union(
        v.literal("checkout_action"),
        v.literal("confirm"),
        v.literal("webhook"),
        v.literal("repair"),
      ),
    ),
    last_result: v.optional(
      v.union(
        v.literal("created"),
        v.literal("paid_seen"),
        v.literal("credited"),
        v.literal("already_processed"),
        v.literal("failed"),
      ),
    ),
    last_error: v.optional(v.string()),
    credited_at: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_user_created_at", ["user_id", "created_at"])
    .index("by_stripe_checkout_session_id", ["stripe_checkout_session_id"])
    .index("by_stripe_payment_intent_id", ["stripe_payment_intent_id"])
    .index("by_stripe_invoice_id", ["stripe_invoice_id"]),

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
    auto_reload_operation_id: v.optional(v.string()),
    auto_reload_operation_executor_id: v.optional(v.string()),
    auto_reload_operation_started_at: v.optional(v.number()),
    auto_reload_operation_lease_expires_at: v.optional(v.number()),
    auto_reload_operation_amount_dollars: v.optional(v.number()),
    auto_reload_operation_stripe_invoice_id: v.optional(v.string()),
    auto_reload_retry_after: v.optional(v.number()),
    auto_reload_last_failure_reason: v.optional(v.string()),
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

  // Durable tombstone created before account deletion starts. It prevents
  // concurrent requests from provisioning new execution resources after the
  // deletion route has enumerated the user's existing resources.
  user_deletion_fences: defineTable({
    user_id: v.string(),
    started_at: v.number(),
  }).index("by_user_id", ["user_id"]),

  user_suspensions: defineTable({
    user_id: v.string(),
    status: v.union(v.literal("active"), v.literal("resolved")),
    category: v.union(
      v.literal("early_fraud_warning"),
      v.literal("dispute_fraudulent"),
      v.literal("dispute_billing_hold"),
      v.literal("support_confirmed_fraud"),
    ),
    source: v.union(v.literal("stripe"), v.literal("support")),
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
    // Keep accepting legacy cloud rows until production data has been purged.
    // No current writer creates them, and connection queries exclude them.
    mode: v.union(
      v.literal("docker"),
      v.literal("dangerous"),
      v.literal("cloud"),
    ),
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
        files: v.optional(v.boolean()),
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
        v.literal("command_unresponsive"),
      ),
    ),
  })
    .index("by_user_id", ["user_id"])
    .index("by_connection_id", ["connection_id"])
    .index("by_user_and_status", ["user_id", "status"])
    .index("by_user_and_status_and_mode", ["user_id", "status", "mode"])
    .index("by_status_and_created_at", ["status", "created_at"]),

  // Per-request usage logs for the usage dashboard
  usage_logs: defineTable({
    usage_settlement_id: v.optional(v.string()),
    user_id: v.string(),
    organization_id: v.optional(v.string()),
    chat_id: v.optional(v.string()),
    assistant_message_id: v.optional(v.string()),
    endpoint: v.optional(
      v.union(
        v.literal("/api/chat"),
        v.literal("/api/agent"),
        v.literal("/api/agent-long"),
      ),
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
    // Long-lived development deployments can still contain rows written
    // before the redundant usage fields were removed. Keep read
    // compatibility so current functions can deploy; new writes omit them.
    total_tokens: v.optional(v.number()),
    cache_read_tokens: v.optional(v.number()),
    cache_write_tokens: v.optional(v.number()),
    cost_dollars: v.number(),
    included_cost_dollars: v.optional(v.number()),
    extra_usage_cost_dollars: v.optional(v.number()),
    uncovered_cost_dollars: v.optional(v.number()),
    included_points_deducted: v.optional(v.number()),
    extra_usage_points_deducted: v.optional(v.number()),
    uncovered_points: v.optional(v.number()),
    usage_deduction_failed: v.optional(v.boolean()),
    usage_deduction_failure_reason: v.optional(
      usageDeductionFailureReasonValidator,
    ),
    model_cost_dollars: v.optional(v.number()),
    non_model_cost_dollars: v.optional(v.number()),
    cost_source: v.optional(
      v.union(
        v.literal("provider"),
        v.literal("hybrid"),
        v.literal("token_estimate"),
        v.literal("raw_token_estimate"),
      ),
    ),
    max_mode: v.optional(v.boolean()),
    byok: v.optional(v.boolean()),
  })
    .index("by_usage_settlement_id", ["usage_settlement_id"])
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

  // Shared infrastructure charges and provider usage. This remains separate
  // from user economics so platform overhead is never allocated or counted
  // more than once by accident.
  platform_costs_daily: defineTable({
    vendor: v.union(v.literal("vercel"), v.literal("convex")),
    entity_id: v.string(),
    day: v.string(),
    service_name: v.string(),
    service_category: v.string(),
    charge_category: v.optional(v.string()),
    billing_currency: v.optional(v.string()),
    cost_status: v.union(
      v.literal("billed"),
      v.literal("estimated"),
      v.literal("metered"),
    ),
    billed_cost_dollars: v.optional(v.number()),
    effective_cost_dollars: v.optional(v.number()),
    recognized_cost_dollars: v.number(),
    gross_profit_impact_dollars: v.number(),
    usage_quantity: v.optional(v.number()),
    usage_unit: v.optional(v.string()),
    source_period_start: v.string(),
    source_period_end: v.string(),
    source_observed_at: v.number(),
    source_charge_count: v.optional(v.number()),
    updated_at: v.number(),
  })
    .index("by_day", ["day"])
    .index("by_vendor_day", ["vendor", "day"]),

  // Restricted, privacy-safe product research. Raw messages are read only by
  // the service-keyed analysis task and are never stored in these tables.
  research_runs: defineTable({
    analysis_id: v.string(),
    linear_issue_id: v.optional(v.string()),
    question: v.string(),
    cohort_label: v.string(),
    requested_by: v.string(),
    // Optional for compatibility with v1 audit rows. New runs always write
    // bounded provenance without storing the source query or request payload.
    cohort_source: v.optional(v.literal("posthog")),
    posthog_project_id: v.optional(v.number()),
    cohort_selected_at: v.optional(v.number()),
    selection_query_fingerprint: v.optional(v.string()),
    selection_limitations: v.optional(v.array(v.string())),
    sampling_mode: v.optional(
      v.union(v.literal("representative"), v.literal("pre_event")),
    ),
    evidence_window_days: v.optional(v.number()),
    cohort_size: v.number(),
    max_chats_per_user: v.number(),
    model: v.string(),
    reasoning_enabled: v.boolean(),
    reasoning_effort: v.optional(v.literal("low")),
    status: researchRunStatusValidator,
    profiles_completed: v.number(),
    profiles_failed: v.number(),
    input_tokens: v.optional(v.number()),
    output_tokens: v.optional(v.number()),
    cost_dollars: v.optional(v.number()),
    error: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
    completed_at: v.optional(v.number()),
  })
    .index("by_analysis_id", ["analysis_id"])
    .index("by_created_at", ["created_at"]),

  research_run_members: defineTable({
    analysis_id: v.string(),
    user_id: v.string(),
    pseudonym: v.string(),
    evidence_anchor_at: v.optional(v.number()),
    created_at: v.number(),
  })
    .index("by_analysis_and_user", ["analysis_id", "user_id"])
    .index("by_user_id", ["user_id"]),

  research_user_profiles: defineTable({
    analysis_id: v.string(),
    user_id: v.string(),
    pseudonym: v.string(),
    profile: researchUserProfileValidator,
    coverage: researchCoverageValidator,
    model: v.string(),
    prompt_version: v.string(),
    input_tokens: v.optional(v.number()),
    output_tokens: v.optional(v.number()),
    cost_dollars: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_analysis_and_user", ["analysis_id", "user_id"])
    .index("by_user_id", ["user_id"]),

  research_reports: defineTable({
    analysis_id: v.string(),
    report: researchCohortReportValidator,
    model: v.string(),
    prompt_version: v.string(),
    input_tokens: v.optional(v.number()),
    output_tokens: v.optional(v.number()),
    cost_dollars: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.number(),
  }).index("by_analysis_id", ["analysis_id"]),

  // Durable child-agent state. Sensitive objectives and validation artifacts
  // stay here instead of Trigger metadata or analytics properties.
  subagent_runs: defineTable({
    subagent_id: v.string(),
    user_id: v.string(),
    organization_id: v.optional(v.string()),
    chat_id: v.string(),
    parent_message_id: v.string(),
    parent_tool_call_id: v.string(),
    parent_trigger_run_id: v.string(),
    trigger_run_id: v.optional(v.string()),
    profile: v.union(
      v.literal("general"),
      v.literal("security_task"),
      v.literal("security_validation"),
    ),
    depth: v.number(),
    status: subagentStatusValidator,
    name: v.optional(v.string()),
    objective: v.string(),
    success_criteria: v.optional(v.array(v.string())),
    inherit_context: v.optional(v.boolean()),
    skills: v.optional(v.array(v.string())),
    capability_bundles: v.optional(v.array(v.string())),
    task_complexity: v.optional(v.string()),
    expected_duration_minutes: v.optional(v.number()),
    output_kind: v.optional(v.string()),
    continuation_count: v.optional(v.number()),
    continuation_prompt: v.optional(v.string()),
    candidate: v.optional(
      v.object({
        title: v.string(),
        affected_asset: v.string(),
        weakness_class: v.string(),
        claimed_impact: v.string(),
        reproduction_hint: v.optional(v.string()),
      }),
    ),
    candidate_fingerprint: v.string(),
    context_refs: v.array(v.any()),
    sandbox_preference: v.optional(v.string()),
    sandbox_identity: v.optional(v.string()),
    permission_mode: v.optional(v.string()),
    selected_model: v.optional(v.string()),
    subscription: v.union(
      v.literal("free"),
      v.literal("pro"),
      v.literal("pro-plus"),
      v.literal("ultra"),
      v.literal("team"),
    ),
    free_quota_subject: v.optional(v.string()),
    user_location: v.optional(v.any()),
    summary: v.optional(v.string()),
    verdict: v.optional(subagentVerdictValidator),
    confidence: v.optional(validationConfidenceValidator),
    structured_result: v.optional(v.any()),
    failure_code: v.optional(v.string()),
    failure_reason: v.optional(v.string()),
    cancel_reason: v.optional(v.string()),
    cost_limit_dollars: v.number(),
    cost_dollars: v.optional(v.number()),
    step_count: v.optional(v.number()),
    provider_retry_count: v.optional(v.number()),
    result_recovery_count: v.optional(v.number()),
    parent_delivery_claim_id: v.optional(v.string()),
    parent_delivery_claimed_at: v.optional(v.number()),
    parent_delivery_claim_expires_at: v.optional(v.number()),
    parent_result_injected_at: v.optional(v.number()),
    parent_result_consumed_at: v.optional(v.number()),
    // Compatibility field for existing dashboards. New code writes it only
    // after a parent model step has consumed the result.
    parent_notified_at: v.optional(v.number()),
    created_at: v.number(),
    started_at: v.optional(v.number()),
    completed_at: v.optional(v.number()),
    updated_at: v.number(),
  })
    .index("by_subagent_id", ["subagent_id"])
    .index("by_chat_id", ["chat_id"])
    .index("by_user_id", ["user_id"])
    .index("by_chat_and_status", ["chat_id", "status"])
    .index("by_user_and_status", ["user_id", "status"])
    .index("by_chat_status_and_cancel_reason", [
      "chat_id",
      "status",
      "cancel_reason",
    ])
    .index("by_user_status_and_cancel_reason", [
      "user_id",
      "status",
      "cancel_reason",
    ])
    .index("by_parent_run_and_tool_call", [
      "parent_trigger_run_id",
      "parent_tool_call_id",
    ])
    .index("by_user_chat_and_parent_run", [
      "user_id",
      "chat_id",
      "parent_trigger_run_id",
    ])
    .index("by_user_and_chat", ["user_id", "chat_id"])
    .index("by_parent_run", ["parent_trigger_run_id"])
    .index("by_user_and_parent_message", ["user_id", "parent_message_id"])
    .index("by_user_chat_and_candidate", [
      "user_id",
      "chat_id",
      "candidate_fingerprint",
    ]),

  subagent_messages: defineTable({
    subagent_id: v.string(),
    user_id: v.string(),
    sequence: v.number(),
    role: v.union(
      v.literal("user"),
      v.literal("assistant"),
      v.literal("system"),
    ),
    parts: v.array(v.any()),
    feedback_type: v.optional(
      v.union(v.literal("positive"), v.literal("negative")),
    ),
    feedback_details: v.optional(v.string()),
    message_source: v.optional(v.literal("parent_update")),
    external_message_id: v.optional(v.string()),
    parent_tool_call_id: v.optional(v.string()),
    message_type: v.optional(
      v.union(
        v.literal("query"),
        v.literal("instruction"),
        v.literal("information"),
      ),
    ),
    priority: v.optional(
      v.union(
        v.literal("low"),
        v.literal("normal"),
        v.literal("high"),
        v.literal("urgent"),
      ),
    ),
    delivery_status: v.optional(
      v.union(v.literal("pending"), v.literal("consumed")),
    ),
    consumed_at: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_subagent_and_sequence", ["subagent_id", "sequence"])
    .index("by_subagent_and_created_at", ["subagent_id", "created_at"])
    .index("by_subagent_and_delivery_status", [
      "subagent_id",
      "delivery_status",
    ])
    .index("by_subagent_and_external_message_id", [
      "subagent_id",
      "external_message_id",
    ])
    .index("by_user_id", ["user_id"]),

  subagent_events: defineTable({
    subagent_id: v.string(),
    user_id: v.string(),
    parent_trigger_run_id: v.string(),
    event_type: v.union(
      v.literal("progress"),
      v.literal("question"),
      v.literal("blocker"),
      v.literal("artifact"),
      v.literal("result"),
    ),
    message: v.string(),
    refs: v.array(v.string()),
    consumed_at: v.optional(v.number()),
    created_at: v.number(),
  })
    .index("by_subagent", ["subagent_id"])
    .index("by_user_id", ["user_id"])
    .index("by_parent_run", ["parent_trigger_run_id"])
    .index("by_parent_run_and_consumed_at", [
      "parent_trigger_run_id",
      "consumed_at",
    ]),

  subagent_work_items: defineTable({
    subagent_id: v.string(),
    user_id: v.string(),
    parent_trigger_run_id: v.string(),
    owner: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("in_progress"),
      v.literal("blocked"),
      v.literal("completed"),
    ),
    dependencies: v.array(v.string()),
    refs: v.array(v.string()),
    claims: v.array(v.object({ claim: v.string(), provenance: v.string() })),
    assessed_scope: v.array(v.string()),
    unassessed_scope: v.array(v.string()),
    artifacts: v.array(
      v.object({
        path: v.string(),
        description: v.optional(v.string()),
      }),
    ),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_subagent", ["subagent_id"])
    .index("by_user_id", ["user_id"])
    .index("by_parent_run", ["parent_trigger_run_id"]),

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
