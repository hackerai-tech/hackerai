import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { validateServiceKey } from "./lib/utils";

const stripeEventTypeValidator = v.union(
  v.literal("invoice.payment_failed"),
  v.literal("invoice.paid"),
  v.literal("customer.subscription.deleted"),
  v.literal("payment_method.attached"),
  v.literal("customer.updated"),
);

const subscriptionTierValidator = v.union(
  v.literal("free"),
  v.literal("pro"),
  v.literal("pro-plus"),
  v.literal("ultra"),
  v.literal("team"),
);

const billingFailureLifecycleValidator = v.union(
  v.literal("invoice_payment_failed"),
  v.literal("subscription_deleted"),
);

const recoveryResultValidator = v.union(
  v.literal("pending"),
  v.literal("payment_method_updated"),
  v.literal("recovered"),
  v.literal("churned"),
  v.literal("ineligible_payment"),
);

const argsValidator = {
  serviceKey: v.string(),
  stripeEventId: v.string(),
  stripeEventType: stripeEventTypeValidator,
  userId: v.string(),
  organizationId: v.optional(v.string()),
  stripeCustomerId: v.string(),
  stripeSubscriptionId: v.string(),
  stripeInvoiceId: v.optional(v.string()),
  stripePaymentIntentId: v.optional(v.string()),
  stripeChargeId: v.optional(v.string()),
  stripePriceId: v.optional(v.string()),
  plan: v.optional(v.string()),
  subscriptionTier: v.optional(subscriptionTierValidator),
  billingFailureLifecycle: v.optional(billingFailureLifecycleValidator),
  billingFailureStage: v.optional(v.string()),
  billingFailureGroup: v.optional(v.string()),
  billingReason: v.optional(v.string()),
  invoiceStatus: v.optional(v.string()),
  attemptCount: v.optional(v.number()),
  outcomeType: v.optional(v.string()),
  outcomeReason: v.optional(v.string()),
  riskLevel: v.optional(v.string()),
  amountDueDollars: v.optional(v.number()),
  amountRemainingDollars: v.optional(v.number()),
  currency: v.optional(v.string()),
  invoicePaidEligible: v.optional(v.boolean()),
  priorFailureKnown: v.optional(v.boolean()),
  occurredAt: v.number(),
};

/**
 * Record one privacy-safe involuntary-churn lifecycle fact per Stripe event and
 * affected user. invoice.paid is stored only when the invoice previously had a
 * failure record, which keeps normal successful renewals out of this table.
 */
export const recordEvent = mutation({
  args: argsValidator,
  returns: v.object({
    inserted: v.boolean(),
    priorFailureSeen: v.boolean(),
    recoveryResult: v.optional(recoveryResultValidator),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const idempotencyKey = `${args.stripeEventId}:${args.userId}`;
    const existing = await ctx.db
      .query("involuntary_churn_events")
      .withIndex("by_idempotency_key", (q) =>
        q.eq("idempotency_key", idempotencyKey),
      )
      .unique();

    if (existing) {
      return {
        inserted: false,
        // Every row in this table is either a failure or an outcome gated on a
        // known failure, so replaying an existing event proves prior failure.
        priorFailureSeen: true,
        recoveryResult: existing.recovery_result,
      };
    }

    const invoiceEvents = args.stripeInvoiceId
      ? await ctx.db
          .query("involuntary_churn_events")
          .withIndex("by_invoice_user_and_occurred", (q) =>
            q
              .eq("stripe_invoice_id", args.stripeInvoiceId)
              .eq("user_id", args.userId),
          )
          .order("desc")
          .take(100)
      : [];
    const priorFailureSeen = invoiceEvents.some(
      (event) =>
        event.stripe_event_type === "invoice.payment_failed" ||
        event.stripe_event_type === "customer.subscription.deleted",
    );

    const isPaymentMethodEvent =
      args.stripeEventType === "payment_method.attached" ||
      args.stripeEventType === "customer.updated";
    if (
      (args.stripeEventType === "invoice.paid" || isPaymentMethodEvent) &&
      !priorFailureSeen &&
      args.priorFailureKnown !== true
    ) {
      return { inserted: false, priorFailureSeen: false };
    }

    const recoveryResult =
      args.stripeEventType === "invoice.payment_failed"
        ? ("pending" as const)
        : args.stripeEventType === "customer.subscription.deleted"
          ? ("churned" as const)
          : args.stripeEventType === "invoice.paid"
            ? args.invoicePaidEligible === false
              ? ("ineligible_payment" as const)
              : ("recovered" as const)
            : ("payment_method_updated" as const);

    await ctx.db.insert("involuntary_churn_events", {
      idempotency_key: idempotencyKey,
      stripe_event_id: args.stripeEventId,
      stripe_event_type: args.stripeEventType,
      user_id: args.userId,
      organization_id: args.organizationId,
      stripe_customer_id: args.stripeCustomerId,
      stripe_subscription_id: args.stripeSubscriptionId,
      stripe_invoice_id: args.stripeInvoiceId,
      stripe_payment_intent_id: args.stripePaymentIntentId,
      stripe_charge_id: args.stripeChargeId,
      stripe_price_id: args.stripePriceId,
      plan: args.plan,
      subscription_tier: args.subscriptionTier,
      billing_failure_lifecycle: args.billingFailureLifecycle,
      billing_failure_stage: args.billingFailureStage,
      billing_failure_group: args.billingFailureGroup,
      billing_reason: args.billingReason,
      invoice_status: args.invoiceStatus,
      attempt_count: args.attemptCount,
      outcome_type: args.outcomeType,
      outcome_reason: args.outcomeReason,
      risk_level: args.riskLevel,
      amount_due_dollars: args.amountDueDollars,
      amount_remaining_dollars: args.amountRemainingDollars,
      currency: args.currency,
      recovery_result: recoveryResult,
      occurred_at: args.occurredAt,
      recorded_at: Date.now(),
    });

    return {
      inserted: true,
      priorFailureSeen: priorFailureSeen || args.priorFailureKnown === true,
      recoveryResult,
    };
  },
});
