# Unit Economics Tracking

Convex is the durable source of truth for paid per-user and per-organization
unit economics. PostHog should consume compact warehouse tables from Convex
rather than raw request events.

## Data Model

- `usage_logs`: one row per paid cost-bearing AI request. Stores token counts,
  model cost, non-model cost, subscription tier, chat, endpoint, and org
  context.
- `revenue_events`: append-only Stripe revenue ledger. Stores subscription,
  personal extra usage, and team extra usage revenue with idempotency keys.
  Subscription rows may also include `mrr_dollars`, a normalized monthly
  recurring revenue value derived from the recurring Stripe price cadence.
- `paid_start_events`: append-only subscription-start ledger. Stores one
  idempotent paid-start row per new paid account/subscription, with separate
  account, user, and seat counts, but no revenue amounts.
- `paid_start_mix_daily`: compact daily count rollup by tier, plan, and billing
  interval. Use this for funnel-health mix charts so one high-value
  annual/Ultra start does not dominate the conversion readout.
- `unit_economics_daily`: materialized daily rollups for cheap dashboards and
  PostHog warehouse sync.

Use `entity_type = "user"` for per-user profitability:

```text
net_revenue_dollars - total_cost_dollars = gross_profit_dollars
```

Use `entity_type = "organization"` for team subscription and team extra usage
pool reporting.

Free-plan requests are intentionally excluded from durable Convex usage logging
for now to keep write volume low. They still use the existing free monthly cost
guard, but they do not update `usage_logs` or `unit_economics_daily`.

## PostHog

Sync `unit_economics_daily` from Convex to PostHog. Do not send each request as
a PostHog event for this reporting path.

Recommended PostHog table:

```text
unit_economics_daily
```

Important columns:

- `entity_type`
- `entity_id`
- `user_id`
- `organization_id`
- `day`
- `gross_revenue_dollars`
- `net_revenue_dollars`
- `mrr_dollars`
- `model_cost_dollars`
- `non_model_cost_dollars`
- `total_cost_dollars`
- `gross_profit_dollars`
- `usage_request_count`
- `input_tokens`
- `output_tokens`

For paid-start funnel health, sync this separate count-only table:

```text
paid_start_mix_daily
```

Important columns:

- `day`
- `tier`
- `plan`
- `billing_interval`
- `paid_account_start_count`
- `paid_user_start_count`
- `paid_seat_count`

Use `sum(paid_account_start_count)` for account conversion volume and
breakdowns by `tier`, `plan`, or `billing_interval`. Use
`sum(paid_user_start_count)` or `sum(paid_seat_count)` when you intentionally
want user/seat scale. Do not use `gross_revenue_dollars` or
`net_revenue_dollars` as a proxy for paid starts; annual and Ultra invoices can
otherwise make a weak funnel look healthy. For normalized subscription revenue,
use `mrr_dollars` instead of dividing raw invoice revenue in dashboards.

## Backfill

New paid requests and revenue update `unit_economics_daily` automatically. For
older `usage_logs`, run the service-key guarded Convex mutation:

```text
unitEconomics.rebuildEntityDailyRollups({
  serviceKey,
  entityType: "user",
  entityId: "<workos-user-id>",
  startTime: 0,
  endTime: Date.now()
})
```

Run the same mutation with `entityType: "organization"` for team reporting.

By default, reporting backfills and PostHog export queries start at
`2026-05-31`, because revenue tracking was introduced from that date and older
AI costs would otherwise be compared against missing revenue. Use
`includeHistorical: true` only for one-off audits that intentionally inspect
pre-reporting-window rows.

The mutation rebuilds only one user or one organization at a time and returns
`truncated: true` if the row cap was hit. Re-run with a narrower time range when
that happens.

Paid-start mix rows update automatically from new `subscription_create`
invoices. To rebuild paid-start mix from existing `paid_start_events`, run:

```text
unitEconomics.rebuildPaidStartMixDailyRollups({
  serviceKey,
  startDay: "2026-01-01",
  endDay: "2026-01-31"
})
```

This mutation also returns `truncated: true` when the row cap is hit. Re-run
with a narrower day range when that happens.

## Revenue Accuracy

Stripe revenue is recorded when credits are granted or subscription invoices are
paid. `net_revenue_dollars` currently equals gross Stripe revenue unless a
future Stripe balance-transaction sync fills in processor fees. This keeps
model and request expenses exact while leaving payment processing fees explicit
instead of hidden in the model-cost calculation.

`mrr_dollars` is not cash collected. It normalizes full subscription create and
cycle invoices to monthly recurring value from the Stripe recurring price
interval, for example annual price divided by 12. Raw invoice cash remains in
`gross_revenue_dollars` and `net_revenue_dollars`.
