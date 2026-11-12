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
- PostHog billing-spend rows use `cost_status = 'estimated'` and preserve the
  provider's USD amount in `effective_cost_dollars`. Recognized cost uses that
  amount; it is provisional spend, not a finalized invoice. Queries must report
  billed and estimated coverage separately. Missing days are rejected before
  replacing stored rows, rather than being converted to zero.
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

The `/api/cron/platform-costs/posthog` route runs daily at 12:47 UTC and requires
`POSTHOG_BILLING_READ_TOKEN`, `POSTHOG_BILLING_ORGANIZATION_ID`,
`POSTHOG_BILLING_CUSTOMER_ID`, and a comma-separated `POSTHOG_BILLING_PROJECT_IDS`
scope. Use a dedicated key with only `billing:read`, restricted to the owning
organization. An ingestion or sourcemap key does not imply billing access.
The job uses `/api/billing/spend/`, passes project IDs as a JSON array, and checks
the returned customer ID before replacing any data. This endpoint avoids the
separate organization API's beta gate. It reconciles the previous 35 complete
UTC days to pick up corrections. A missing reader returns 503 without replacing
data. Verify the actual response and environment identity before activation.
See the [PostHog billing API reference](https://posthog.com/docs/api/billing-2).

This table does not imply complete company expense coverage. Provider invoices
for models, sandboxes, and workers must be reconciled against serving costs
already recorded per request; adding those invoices in full would double count.

## Connected operating-cost observations

WorkOS billing can be collected through its authenticated billing connector,
and Upstash exposes a `dailybilling` series per Redis database. An operator can
normalize these observations with `scripts/billing/import-operating-costs.mjs`.
This uses the operator's existing Convex login and the admin-only
`operatingCosts:importBillingWindow` mutation; browser clients and the ordinary
service credential cannot submit these new invoice imports. Vendor connector
tokens are never copied into the app.

Supply private JSON files with `--config` (explicit account/project/deployment
identity and source scope) and `--snapshot` (fresh billing observations).
Use `--dry-run` to validate amounts, complete-day coverage and source scope
without accessing credentials or a backend. A real import independently checks
the management API's account/project/reference and configured custom domain
before authorizing the explicitly named deployment. Never use an inferred
deployment or print credentials. Missing periods, resources, currencies or
amounts fail before replacing known costs. Refresh the connected platform-cost
warehouse table after successful imports.

WorkOS invoices and current-period estimates are spread across their billing
period in integer cents. `cost_basis = 'billing_period_allocation'` identifies
these daily allocations; they are not exact daily consumption. A final invoice
replaces the same period's forecast. Current-period allocations remain
estimated, and invoice references preserve provenance. Fixed fees and variable
usage are not added again on top of the provider total.

Upstash's daily amounts already include its fixed-plan charge. Do not add the
plan price separately. Import only complete UTC days present for every expected
database, retain previous days outside the returned window, and mark these
observations estimated until reconciled with invoices. A missing date is unknown,
not zero. Invoices paid through a marketplace must not also be counted in full
as a second vendor's overhead.

Convex invoice allocations use the same billing import. Its hourly unpriced
usage observations and priced charges have separate replacement scopes, so
refreshing either cannot delete or double count the other.

Convex billing observations contain every approved billing account, each
invoice's net amount due after applied balance, and its service-period subtotals.
The invoice list's gross amount is insufficient. A single invoice can contain
the next period's prepaid minimum and the previous period's overage. Allocate
its net cents proportionally to those subtotals first, then spread each part
across its own UTC service dates. Both allocation stages preserve their exact
input cents. Reported credits therefore reduce the total once; the included
minimum and its usage are not added a second time.

Paid seat prorations may overlap an existing monthly seat period; they are
separate charges and must both be retained. A fully credited invoice has a
known zero net amount. Include the current draft's explicit service-period
amounts, including known zero overage, and retain its estimated status. Missing
invoices, source accounts or dates must fail the import rather than creating
zero placeholders. Do not infer service periods from local issue/payment dates.
These are daily allocations of net invoice charges, not exact resource-level
consumption or a complete cash/credit-note reconciliation.

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
