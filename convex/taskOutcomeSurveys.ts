import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { validateServiceKey } from "./lib/utils";
import { isUserDeletionFenced } from "./lib/userDeletionFence";
import {
  taskOutcomeAnswer,
  taskOutcomeContext,
  taskOutcomeDocument,
  taskOutcomeReason,
} from "./taskOutcomeValidators";
import {
  NEW_PAID_SURVEY_WINDOW_MS,
  PAID_TASK_OUTCOME_ANSWERS,
  TASK_OUTCOME_COOLDOWN_MS,
  TASK_OUTCOME_EXPIRY_MS,
  reasonsForAnswer,
} from "../lib/feedback/task-outcome";

// Service-only reservation occurs before model-priced checks or generation. The
// indexed read + insert is atomic, including simultaneous runs on other devices.
export const reserve = mutation({
  args: { serviceKey: v.string(), user_id: v.string(), ...taskOutcomeContext },
  returns: v.union(taskOutcomeDocument, v.null()),
  handler: async (ctx, { serviceKey, ...args }) => {
    validateServiceKey(serviceKey);
    if (await isUserDeletionFenced(ctx.db, args.user_id)) return null;
    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chat_id", (q) => q.eq("id", args.chat_id))
      .unique();
    if (!chat || chat.user_id !== args.user_id) return null;
    const existing = await ctx.db
      .query("task_outcome_surveys")
      .withIndex("by_request_id", (q) => q.eq("request_id", args.request_id))
      .unique();
    if (existing) return null;
    const previous = await ctx.db
      .query("task_outcome_surveys")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.user_id))
      .order("desc")
      .first();
    const now = Date.now();
    if (
      previous &&
      now - previous.last_interaction_at < TASK_OUTCOME_COOLDOWN_MS
    )
      return null;
    // Paid cohort enrollment is derived from durable billing evidence inside
    // this transaction, not from browser properties or model assignment.
    let paidContext = {};
    if (args.survey_kind === "new_paid") {
      if (!["pro", "pro-plus", "ultra"].includes(args.subscription_tier))
        return null;
      const paidStarts = () =>
        ctx.db
          .query("paid_start_events")
          .withIndex("by_entity_type_and_entity_id_and_occurred_at", (q) =>
            q.eq("entity_type", "user").eq("entity_id", args.user_id),
          );
      const first = await paidStarts().order("asc").first();
      if (
        !first ||
        first.organization_id ||
        !["pro", "pro-plus", "ultra"].includes(first.tier) ||
        !first.stripe_subscription_id ||
        !first.stripe_invoice_id ||
        first.occurred_at > now ||
        now - first.occurred_at >= NEW_PAID_SURVEY_WINDOW_MS
      )
        return null;
      const latest = await paidStarts().order("desc").first();
      if (latest?._id !== first._id) return null;
      const payment = await ctx.db
        .query("revenue_events")
        .withIndex("by_idempotency_key", (q) =>
          q.eq(
            "idempotency_key",
            `subscription:${first.stripe_invoice_id}:user:${args.user_id}`,
          ),
        )
        .unique();
      if (
        !payment ||
        payment.source !== "subscription" ||
        payment.gross_revenue_dollars <= 0 ||
        payment.stripe_subscription_id !== first.stripe_subscription_id ||
        payment.entity_type !== "user" ||
        payment.entity_id !== args.user_id ||
        payment.stripe_invoice_id !== first.stripe_invoice_id
      )
        return null;
      const enrolled = await ctx.db
        .query("task_outcome_surveys")
        .withIndex("by_user_id_and_survey_kind", (q) =>
          q.eq("user_id", args.user_id).eq("survey_kind", "new_paid"),
        )
        .first();
      if (enrolled) return null;
      paidContext = {
        paid_start_event_id: first._id,
        paid_started_at: first.occurred_at,
        stripe_subscription_id: first.stripe_subscription_id,
        paid_start_invoice_id: first.stripe_invoice_id,
        ...(first.billing_period_end !== undefined && {
          baseline_renewal_at: first.billing_period_end,
        }),
        ...(first.billing_interval && {
          billing_interval: first.billing_interval,
        }),
      };
    } else if (
      !args.experiment_variant ||
      !args.baseline_model ||
      !args.assigned_model
    ) {
      return null;
    }
    const id = await ctx.db.insert("task_outcome_surveys", {
      ...args,
      ...paidContext,
      selected_at: now,
      last_interaction_at: now,
      expires_at: now + TASK_OUTCOME_EXPIRY_MS,
    });
    return await ctx.db.get(id);
  },
});

export const linkMessage = mutation({
  args: {
    serviceKey: v.string(),
    user_id: v.string(),
    request_id: v.string(),
    message_id: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const row = await ctx.db
      .query("task_outcome_surveys")
      .withIndex("by_request_id", (q) => q.eq("request_id", args.request_id))
      .unique();
    if (
      row &&
      row.user_id === args.user_id &&
      !row.answered_at &&
      !row.dismissed_at
    )
      await ctx.db.patch(row._id, { message_id: args.message_id });
    return null;
  },
});

export const getForMessage = query({
  args: { chat_id: v.string(), message_id: v.string() },
  returns: v.union(taskOutcomeDocument, v.null()),
  handler: async (ctx, args) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user) return null;
    const row = await ctx.db
      .query("task_outcome_surveys")
      .withIndex("by_user_id", (q) => q.eq("user_id", user.subject))
      .order("desc")
      .first();
    if (
      !row ||
      row.chat_id !== args.chat_id ||
      row.message_id !== args.message_id ||
      row.expires_at <= Date.now() ||
      row.dismissed_at ||
      row.answered_at
    )
      return null;
    return row;
  },
});

export const record = mutation({
  args: {
    id: v.id("task_outcome_surveys"),
    action: v.union(
      v.literal("shown"),
      v.literal("viewed"),
      v.literal("dismissed"),
      v.literal("answered"),
      v.literal("reason"),
    ),
    answer: v.optional(taskOutcomeAnswer),
    reason: v.optional(taskOutcomeReason),
  },
  returns: v.union(taskOutcomeDocument, v.null()),
  handler: async (ctx, args) => {
    const user = await ctx.auth.getUserIdentity();
    const row = await ctx.db.get(args.id);
    if (!user || !row || row.user_id !== user.subject)
      throw new ConvexError("Not authorized");
    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chat_id", (q) => q.eq("id", row.chat_id))
      .unique();
    if (
      !chat ||
      chat.user_id !== user.subject ||
      (await isUserDeletionFenced(ctx.db, user.subject))
    )
      return null;
    if (row.expires_at <= Date.now() || row.dismissed_at) return null;
    const now = Date.now();
    if (args.action === "shown") {
      // Return null on another tab/device's claim, so only one surface asks.
      if (row.shown_at || row.answered_at) return null;
      await ctx.db.patch(row._id, { shown_at: now, last_interaction_at: now });
    } else if (args.action === "viewed") {
      if (!row.shown_at) return null;
      if (row.viewed_at) return row;
      await ctx.db.patch(row._id, { viewed_at: now });
    } else if (args.action === "dismissed") {
      if (!row.shown_at || row.answered_at) return null;
      await ctx.db.patch(row._id, {
        dismissed_at: now,
        last_interaction_at: now,
      });
    } else if (args.action === "answered") {
      if (!row.shown_at || !args.answer) return null;
      if (
        row.survey_kind === "new_paid"
          ? !(args.answer in PAID_TASK_OUTCOME_ANSWERS)
          : args.answer === "solved" || args.answer === "helpful"
      )
        return null;
      if (row.answer) return row.answer === args.answer ? row : null;
      await ctx.db.patch(row._id, {
        answer: args.answer,
        answered_at: now,
        last_interaction_at: now,
      });
    } else {
      if (
        !row.answer ||
        !args.reason ||
        !reasonsForAnswer(row.answer).includes(args.reason)
      )
        return null;
      if (row.reason) return row.reason === args.reason ? row : null;
      await ctx.db.patch(row._id, { reason: args.reason });
    }
    return await ctx.db.get(row._id);
  },
});
