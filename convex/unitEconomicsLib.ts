import type { MutationCtx } from "./_generated/server";

export type UnitEconomicsEntityType = "user" | "organization";

export type UnitEconomicsRevenueSource =
  | "subscription"
  | "extra_usage"
  | "team_extra_usage"
  | "manual_adjustment";

export type UnitEconomicsAttributionStrategy =
  | "direct"
  | "split_evenly"
  | "organization_pool";

export function utcDay(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

function finite(value: number | undefined, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export async function applyUnitEconomicsDelta(
  ctx: MutationCtx,
  args: {
    entityType: UnitEconomicsEntityType;
    entityId: string;
    userId?: string;
    organizationId?: string;
    day: string;
    grossRevenueDollars?: number;
    netRevenueDollars?: number;
    modelCostDollars?: number;
    nonModelCostDollars?: number;
    includedUsageCostDollars?: number;
    extraUsageCostDollars?: number;
    usageRequestCount?: number;
    revenueEventCount?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    totalTokens?: number;
  },
) {
  const existing = await ctx.db
    .query("unit_economics_daily")
    .withIndex("by_entity_day", (q) =>
      q
        .eq("entity_type", args.entityType)
        .eq("entity_id", args.entityId)
        .eq("day", args.day),
    )
    .unique();

  const grossRevenueDollars =
    finite(existing?.gross_revenue_dollars) + finite(args.grossRevenueDollars);
  const netRevenueDollars =
    finite(existing?.net_revenue_dollars) + finite(args.netRevenueDollars);
  const modelCostDollars =
    finite(existing?.model_cost_dollars) + finite(args.modelCostDollars);
  const nonModelCostDollars =
    finite(existing?.non_model_cost_dollars) + finite(args.nonModelCostDollars);
  const totalCostDollars = modelCostDollars + nonModelCostDollars;

  const next = {
    entity_type: args.entityType,
    entity_id: args.entityId,
    user_id: args.userId ?? existing?.user_id,
    organization_id: args.organizationId ?? existing?.organization_id,
    day: args.day,
    gross_revenue_dollars: grossRevenueDollars,
    net_revenue_dollars: netRevenueDollars,
    model_cost_dollars: modelCostDollars,
    non_model_cost_dollars: nonModelCostDollars,
    total_cost_dollars: totalCostDollars,
    gross_profit_dollars: netRevenueDollars - totalCostDollars,
    included_usage_cost_dollars:
      finite(existing?.included_usage_cost_dollars) +
      finite(args.includedUsageCostDollars),
    extra_usage_cost_dollars:
      finite(existing?.extra_usage_cost_dollars) +
      finite(args.extraUsageCostDollars),
    usage_request_count:
      finite(existing?.usage_request_count) + finite(args.usageRequestCount),
    revenue_event_count:
      finite(existing?.revenue_event_count) + finite(args.revenueEventCount),
    input_tokens: finite(existing?.input_tokens) + finite(args.inputTokens),
    output_tokens: finite(existing?.output_tokens) + finite(args.outputTokens),
    cache_read_tokens:
      finite(existing?.cache_read_tokens) + finite(args.cacheReadTokens),
    cache_write_tokens:
      finite(existing?.cache_write_tokens) + finite(args.cacheWriteTokens),
    total_tokens: finite(existing?.total_tokens) + finite(args.totalTokens),
    updated_at: Date.now(),
  };

  if (existing) {
    await ctx.db.patch(existing._id, next);
    return existing._id;
  }

  return await ctx.db.insert("unit_economics_daily", next);
}

export async function recordRevenueEventInternal(
  ctx: MutationCtx,
  args: {
    entityType: UnitEconomicsEntityType;
    entityId: string;
    userId?: string;
    organizationId?: string;
    source: UnitEconomicsRevenueSource;
    sourceEventId: string;
    idempotencyKey?: string;
    grossRevenueDollars: number;
    netRevenueDollars?: number;
    currency?: string;
    occurredAt?: number;
    attributionStrategy: UnitEconomicsAttributionStrategy;
    stripeCustomerId?: string;
    stripeSubscriptionId?: string;
    stripeInvoiceId?: string;
    stripeCheckoutSessionId?: string;
    stripePaymentIntentId?: string;
    stripePriceId?: string;
    plan?: string;
    quantity?: number;
    userCount?: number;
    description?: string;
  },
): Promise<{ alreadyRecorded: boolean }> {
  const grossRevenueDollars = finite(args.grossRevenueDollars);
  if (grossRevenueDollars === 0) {
    return { alreadyRecorded: false };
  }

  const idempotencyKey =
    args.idempotencyKey ??
    `${args.source}:${args.sourceEventId}:${args.entityType}:${args.entityId}`;
  const existing = await ctx.db
    .query("revenue_events")
    .withIndex("by_idempotency_key", (q) =>
      q.eq("idempotency_key", idempotencyKey),
    )
    .unique();

  if (existing) {
    return { alreadyRecorded: true };
  }

  const occurredAt = args.occurredAt ?? Date.now();
  const netRevenueDollars = finite(args.netRevenueDollars, grossRevenueDollars);

  await ctx.db.insert("revenue_events", {
    entity_type: args.entityType,
    entity_id: args.entityId,
    user_id: args.userId,
    organization_id: args.organizationId,
    source: args.source,
    source_event_id: args.sourceEventId,
    idempotency_key: idempotencyKey,
    gross_revenue_dollars: grossRevenueDollars,
    net_revenue_dollars: netRevenueDollars,
    currency: args.currency ?? "usd",
    occurred_at: occurredAt,
    attribution_strategy: args.attributionStrategy,
    stripe_customer_id: args.stripeCustomerId,
    stripe_subscription_id: args.stripeSubscriptionId,
    stripe_invoice_id: args.stripeInvoiceId,
    stripe_checkout_session_id: args.stripeCheckoutSessionId,
    stripe_payment_intent_id: args.stripePaymentIntentId,
    stripe_price_id: args.stripePriceId,
    plan: args.plan,
    quantity: args.quantity,
    user_count: args.userCount,
    description: args.description,
    created_at: Date.now(),
  });

  await applyUnitEconomicsDelta(ctx, {
    entityType: args.entityType,
    entityId: args.entityId,
    userId: args.userId,
    organizationId: args.organizationId,
    day: utcDay(occurredAt),
    grossRevenueDollars,
    netRevenueDollars,
    revenueEventCount: 1,
  });

  return { alreadyRecorded: false };
}
