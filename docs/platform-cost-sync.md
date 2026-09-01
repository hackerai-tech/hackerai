# Platform cost sync

Shared infrastructure costs use a dedicated Convex `platform_costs_daily`
table and its PostHog data warehouse sync. They are not emitted as PostHog
events, so retries do not consume event volume and corrected billing rows can
replace prior values.

## Data flow

1. Vercel Cron calls the authenticated platform-cost routes.
2. Vercel FOCUS charges are streamed and aggregated by UTC day, service,
   service category, charge category, currency, and consumed unit.
3. Convex deployment usage is read from the same endpoint used by the official
   `convex deployment usage` command and normalized by metric and UTC day.
4. A service-keyed Convex mutation replaces the bounded vendor/day window.
5. The PostHog Convex warehouse source syncs the rows from
   `convex_platform_costs_daily`.

The Vercel job runs daily and re-reads the previous 35 complete UTC days because
billing data can be corrected after first publication. The Convex job runs at
minute 59 each hour. Both jobs are idempotent; unchanged rows are not patched,
which avoids unnecessary warehouse sync churn.

## Cost semantics

- Vercel rows use `cost_status = 'billed'`. `billed_cost_dollars` is copied to
  `recognized_cost_dollars` and its negative profit effect is stored in
  `gross_profit_impact_dollars`.
- Convex's documented CLI exposes metered deployment usage but not historical
  invoice-dollar allocations. Convex rows therefore use
  `cost_status = 'metered'`, preserve `usage_quantity` and `usage_unit`, and do
  not invent a dollar cost. They can be reconciled to an invoice later without
  rewriting the ingestion path.
- Profit queries should subtract `recognized_cost_dollars` once from aggregate
  economics. The separate table prevents platform overhead from being counted
  in both user-level and organization-level economics.

## Production environment

The platform-cost-specific variables are `CRON_SECRET`,
`VERCEL_BILLING_READ_TOKEN`, `VERCEL_BILLING_TEAM_ID`, and
`CONVEX_DEPLOYMENT_URL`.

The jobs reuse the app's existing `CONVEX_DEPLOY_KEY` and
`CONVEX_SERVICE_ROLE_KEY` configuration. `CONVEX_DEPLOYMENT_URL` must be the
canonical `https://<deployment>.convex.cloud` URL. Custom application domains,
including those configured through `NEXT_PUBLIC_CONVEX_URL`, do not expose the
authenticated deployment-usage endpoint.

The Vercel token should be scoped to the owning team and used only for this
billing-read integration. Never log it or expose it to the browser.

## PostHog examples

Daily billed platform expense by vendor and service:

```sql
SELECT
    day,
    vendor,
    service_name,
    sum(billed_cost_dollars) AS billed_cost_dollars
FROM convex_platform_costs_daily
WHERE cost_status = 'billed'
GROUP BY day, vendor, service_name
ORDER BY day DESC, billed_cost_dollars DESC
```

Convex metered usage:

```sql
SELECT
    day,
    service_name,
    usage_unit,
    sum(usage_quantity) AS usage_quantity
FROM convex_platform_costs_daily
WHERE vendor = 'convex'
  AND cost_status = 'metered'
GROUP BY day, service_name, usage_unit
ORDER BY day DESC, service_name
```
