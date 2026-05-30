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
- `model_cost_dollars`
- `non_model_cost_dollars`
- `total_cost_dollars`
- `gross_profit_dollars`
- `usage_request_count`
- `input_tokens`
- `output_tokens`

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

The mutation rebuilds only one user or one organization at a time and returns
`truncated: true` if the row cap was hit. Re-run with a narrower time range when
that happens.

## Revenue Accuracy

Stripe revenue is recorded when credits are granted or subscription invoices are
paid. `net_revenue_dollars` currently equals gross Stripe revenue unless a
future Stripe balance-transaction sync fills in processor fees. This keeps
model and request expenses exact while leaving payment processing fees explicit
instead of hidden in the model-cost calculation.
