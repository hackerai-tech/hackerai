import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { validateServiceKey } from "./lib/utils";

const subscriptionTierValidator = v.union(
  v.literal("free"),
  v.literal("pro"),
  v.literal("pro-plus"),
  v.literal("ultra"),
  v.literal("team"),
);

const modeValidator = v.union(
  v.literal("ask"),
  v.literal("agent"),
  v.literal("agent-long"),
);

const optionalAttributionArgs = {
  utm_source: v.optional(v.string()),
  utm_medium: v.optional(v.string()),
  utm_campaign: v.optional(v.string()),
  utm_content: v.optional(v.string()),
  utm_term: v.optional(v.string()),
  gclid: v.optional(v.string()),
  fbclid: v.optional(v.string()),
  landing_page: v.optional(v.string()),
  referrer: v.optional(v.string()),
};

const dayFromMs = (ms: number): string =>
  new Date(ms).toISOString().slice(0, 10);

type Tier = "free" | "pro" | "pro-plus" | "ultra" | "team";

function attributionPatch(
  existing: Record<string, unknown> | null,
  args: Record<string, unknown>,
) {
  const patch: Record<string, string> = {};
  for (const key of Object.keys(optionalAttributionArgs)) {
    const incoming = args[key];
    if (
      typeof incoming === "string" &&
      incoming.length > 0 &&
      !existing?.[key]
    ) {
      patch[key] = incoming.slice(0, 500);
    }
  }
  return patch;
}

async function upsertUserAccountImpl(
  ctx: any,
  args: {
    user_id: string;
    current_subscription_tier?: Tier;
    stripe_customer_id?: string;
    workos_organization_id?: string;
    first_paid_at?: number;
    utm_source?: string;
    utm_medium?: string;
    utm_campaign?: string;
    utm_content?: string;
    utm_term?: string;
    gclid?: string;
    fbclid?: string;
    landing_page?: string;
    referrer?: string;
  },
) {
  const now = Date.now();
  const existing = await ctx.db
    .query("user_accounts")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", args.user_id))
    .unique();

  const tier = args.current_subscription_tier ?? "free";
  const firstPaidAt =
    args.first_paid_at ??
    (tier !== "free" && !existing?.first_paid_at ? now : undefined);
  const attrPatch = attributionPatch(existing, args);

  if (!existing) {
    await ctx.db.insert("user_accounts", {
      user_id: args.user_id,
      first_seen_at: now,
      last_seen_at: now,
      current_subscription_tier: tier,
      ...(firstPaidAt && { first_paid_at: firstPaidAt }),
      ...(args.stripe_customer_id && {
        stripe_customer_id: args.stripe_customer_id,
      }),
      ...(args.workos_organization_id && {
        workos_organization_id: args.workos_organization_id,
      }),
      ...attrPatch,
      updated_at: now,
    });
    return;
  }

  await ctx.db.patch(existing._id, {
    last_seen_at: now,
    ...(args.current_subscription_tier && {
      current_subscription_tier: args.current_subscription_tier,
    }),
    ...(firstPaidAt &&
      !existing.first_paid_at && { first_paid_at: firstPaidAt }),
    ...(args.stripe_customer_id && {
      stripe_customer_id: args.stripe_customer_id,
    }),
    ...(args.workos_organization_id && {
      workos_organization_id: args.workos_organization_id,
    }),
    ...attrPatch,
    updated_at: now,
  });
}

async function updateDailyEconomics(
  ctx: any,
  args: {
    day: string;
    user_id: string;
    subscription_tier: Tier;
    request_count?: number;
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    llm_cost_dollars?: number;
    tool_cost_dollars?: number;
    total_cost_dollars?: number;
    gross_revenue_dollars?: number;
    refund_dollars?: number;
    net_revenue_dollars?: number;
  },
) {
  const now = Date.now();
  const existing = await ctx.db
    .query("user_economics_daily")
    .withIndex("by_day_user_tier", (q: any) =>
      q
        .eq("day", args.day)
        .eq("user_id", args.user_id)
        .eq("subscription_tier", args.subscription_tier),
    )
    .unique();

  const delta = {
    request_count: args.request_count ?? 0,
    input_tokens: args.input_tokens ?? 0,
    output_tokens: args.output_tokens ?? 0,
    total_tokens: args.total_tokens ?? 0,
    llm_cost_dollars: args.llm_cost_dollars ?? 0,
    tool_cost_dollars: args.tool_cost_dollars ?? 0,
    total_cost_dollars: args.total_cost_dollars ?? 0,
    gross_revenue_dollars: args.gross_revenue_dollars ?? 0,
    refund_dollars: args.refund_dollars ?? 0,
    net_revenue_dollars: args.net_revenue_dollars ?? 0,
  };

  if (!existing) {
    await ctx.db.insert("user_economics_daily", {
      day: args.day,
      user_id: args.user_id,
      subscription_tier: args.subscription_tier,
      ...delta,
      updated_at: now,
    });
    return;
  }

  await ctx.db.patch(existing._id, {
    request_count: existing.request_count + delta.request_count,
    input_tokens: existing.input_tokens + delta.input_tokens,
    output_tokens: existing.output_tokens + delta.output_tokens,
    total_tokens: existing.total_tokens + delta.total_tokens,
    llm_cost_dollars: existing.llm_cost_dollars + delta.llm_cost_dollars,
    tool_cost_dollars: existing.tool_cost_dollars + delta.tool_cost_dollars,
    total_cost_dollars: existing.total_cost_dollars + delta.total_cost_dollars,
    gross_revenue_dollars:
      existing.gross_revenue_dollars + delta.gross_revenue_dollars,
    refund_dollars: existing.refund_dollars + delta.refund_dollars,
    net_revenue_dollars:
      existing.net_revenue_dollars + delta.net_revenue_dollars,
    updated_at: now,
  });
}

export const upsertUserAccount = mutation({
  args: {
    serviceKey: v.string(),
    user_id: v.string(),
    current_subscription_tier: v.optional(subscriptionTierValidator),
    stripe_customer_id: v.optional(v.string()),
    workos_organization_id: v.optional(v.string()),
    first_paid_at: v.optional(v.number()),
    ...optionalAttributionArgs,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    await upsertUserAccountImpl(ctx, args);
    return null;
  },
});

export const aggregateUsage = mutation({
  args: {
    serviceKey: v.string(),
    user_id: v.string(),
    subscription_tier: subscriptionTierValidator,
    mode: modeValidator,
    model: v.string(),
    type: v.union(v.literal("included"), v.literal("extra")),
    input_tokens: v.number(),
    output_tokens: v.number(),
    cache_read_tokens: v.optional(v.number()),
    cache_write_tokens: v.optional(v.number()),
    total_tokens: v.number(),
    model_cost_dollars: v.number(),
    non_model_cost_dollars: v.number(),
    total_cost_dollars: v.number(),
    occurred_at: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const day = dayFromMs(args.occurred_at ?? Date.now());

    await updateDailyEconomics(ctx, {
      day,
      user_id: args.user_id,
      subscription_tier: args.subscription_tier,
      request_count: 1,
      input_tokens: args.input_tokens,
      output_tokens: args.output_tokens,
      total_tokens: args.total_tokens,
      llm_cost_dollars: args.model_cost_dollars,
      tool_cost_dollars: args.non_model_cost_dollars,
      total_cost_dollars: args.total_cost_dollars,
    });
    await upsertUserAccountImpl(ctx, {
      user_id: args.user_id,
      current_subscription_tier: args.subscription_tier,
    });

    return null;
  },
});

export const recordRevenueEvent = mutation({
  args: {
    serviceKey: v.string(),
    dedupe_key: v.string(),
    stripe_event_id: v.string(),
    event_type: v.string(),
    revenue_type: v.union(
      v.literal("subscription"),
      v.literal("extra_usage"),
      v.literal("refund"),
      v.literal("dispute"),
      v.literal("adjustment"),
    ),
    occurred_at: v.number(),
    user_id: v.optional(v.string()),
    organization_id: v.optional(v.string()),
    stripe_customer_id: v.optional(v.string()),
    stripe_invoice_id: v.optional(v.string()),
    stripe_subscription_id: v.optional(v.string()),
    stripe_checkout_session_id: v.optional(v.string()),
    tier: v.optional(subscriptionTierValidator),
    currency: v.optional(v.string()),
    gross_revenue_dollars: v.number(),
    refund_dollars: v.optional(v.number()),
    dispute_dollars: v.optional(v.number()),
    stripe_fee_dollars: v.optional(v.number()),
    net_revenue_dollars: v.number(),
    metadata: v.optional(v.any()),
  },
  returns: v.object({ alreadyProcessed: v.boolean() }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    if (!args.user_id) return { alreadyProcessed: false };

    const economicsEventId = `economics:${args.dedupe_key}`;
    const existingEvent = await ctx.db
      .query("processed_webhooks")
      .withIndex("by_event_id", (q) => q.eq("event_id", economicsEventId))
      .unique();

    if (existingEvent) {
      return { alreadyProcessed: true };
    }

    const tier = args.tier ?? "free";
    await updateDailyEconomics(ctx, {
      day: dayFromMs(args.occurred_at),
      user_id: args.user_id,
      subscription_tier: tier,
      gross_revenue_dollars: args.gross_revenue_dollars,
      refund_dollars: (args.refund_dollars ?? 0) + (args.dispute_dollars ?? 0),
      net_revenue_dollars: args.net_revenue_dollars,
    });
    await upsertUserAccountImpl(ctx, {
      user_id: args.user_id,
      current_subscription_tier: tier,
      stripe_customer_id: args.stripe_customer_id,
      workos_organization_id: args.organization_id,
      first_paid_at:
        args.net_revenue_dollars > 0 && args.revenue_type !== "refund"
          ? args.occurred_at
          : undefined,
    });
    await ctx.db.insert("processed_webhooks", {
      event_id: economicsEventId,
      processed_at: Date.now(),
      status: "completed",
    });

    return { alreadyProcessed: false };
  },
});

export const getEconomicsSummary = query({
  args: {
    serviceKey: v.string(),
    startDay: v.string(),
    endDay: v.string(),
  },
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const rows = await ctx.db
      .query("user_economics_daily")
      .withIndex("by_day", (q) =>
        q.gte("day", args.startDay).lte("day", args.endDay),
      )
      .collect();

    const activeUsers = new Set<string>();
    const activeFreeUsers = new Set<string>();
    const activePaidUsers = new Set<string>();
    let requestCount = 0;
    let freeCost = 0;
    let paidCost = 0;
    let totalCost = 0;
    let grossRevenue = 0;
    let refundDollars = 0;
    let netRevenue = 0;

    for (const row of rows) {
      activeUsers.add(row.user_id);
      requestCount += row.request_count;
      totalCost += row.total_cost_dollars;
      grossRevenue += row.gross_revenue_dollars;
      refundDollars += row.refund_dollars;
      netRevenue += row.net_revenue_dollars;

      if (row.subscription_tier === "free") {
        activeFreeUsers.add(row.user_id);
        freeCost += row.total_cost_dollars;
      } else {
        activePaidUsers.add(row.user_id);
        paidCost += row.total_cost_dollars;
      }
    }

    const startMs = Date.parse(`${args.startDay}T00:00:00.000Z`);
    const endMs = Date.parse(`${args.endDay}T23:59:59.999Z`);
    const cohort = await ctx.db
      .query("user_accounts")
      .withIndex("by_first_seen", (q) =>
        q.gte("first_seen_at", startMs).lte("first_seen_at", endMs),
      )
      .collect();

    const converted30d = cohort.filter(
      (account) =>
        account.first_paid_at !== undefined &&
        account.first_paid_at - account.first_seen_at <=
          30 * 24 * 60 * 60 * 1000,
    ).length;

    const activeUserCount = activeUsers.size;
    const activePaidUserCount = activePaidUsers.size;
    const activeFreeUserCount = activeFreeUsers.size;

    return {
      range: { startDay: args.startDay, endDay: args.endDay },
      users: {
        active: activeUserCount,
        activeFree: activeFreeUserCount,
        activePaid: activePaidUserCount,
        signupCohort: cohort.length,
      },
      usage: {
        requests: requestCount,
        freeCostDollars: freeCost,
        paidCostDollars: paidCost,
        totalCostDollars: totalCost,
        freeCostPerActiveFreeUser:
          activeFreeUserCount > 0 ? freeCost / activeFreeUserCount : 0,
        paidCostPerActivePaidUser:
          activePaidUserCount > 0 ? paidCost / activePaidUserCount : 0,
      },
      revenue: {
        grossRevenueDollars: grossRevenue,
        refundDollars,
        netRevenueDollars: netRevenue,
        arpu: activeUserCount > 0 ? netRevenue / activeUserCount : 0,
        arppu: activePaidUserCount > 0 ? netRevenue / activePaidUserCount : 0,
      },
      conversion: {
        freeToPaid30d: cohort.length > 0 ? converted30d / cohort.length : 0,
      },
      margin: {
        contributionDollars: netRevenue - totalCost,
        grossMargin: netRevenue > 0 ? (netRevenue - totalCost) / netRevenue : 0,
      },
    };
  },
});
