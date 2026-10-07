-- HAC-115: account cohorts, original assignment, bounded windows, zero outcomes.
-- Launch lower bound: keep fixed for this version; do not use a rolling window
-- that could relabel returning users as first-time exposures. No customer content.
-- PostHog project 144137; use 401167 only for Preview QA.
WITH accounts AS (
  SELECT
    distinct_id,
    minIf(timestamp, event = 'free_monthly_budget_exposed') AS exposed_at,
    argMinIf(properties.free_monthly_budget_variant, timestamp,
      event = 'free_monthly_budget_exposed') AS variant,
    uniqExactIf(properties.free_monthly_budget_variant,
      event = 'free_monthly_budget_exposed') AS variants_seen,
    countIf(event = 'free_monthly_budget_exposed') AS exposures,
    groupArrayIf(timestamp, event = 'free_response_completed'
      AND properties.activation_definition_version = 1) AS completions,
    groupArrayIf(timestamp, event = 'hackerai-usage_cost') AS usage_times,
    groupArrayIf(tuple(timestamp, coalesce(toFloat(properties.cost_dollars), 0)),
      event = 'hackerai-usage_cost' AND properties.subscription_tier = 'free') AS costs,
    groupArrayIf(timestamp, event = 'hackerai-agent_run'
      AND properties.subscription_tier = 'free') AS agent_runs,
    groupArrayIf(timestamp, event = 'hackerai-agent_run'
      AND properties.subscription_tier = 'free'
      AND properties.abort_source = 'budget_exhausted'
      AND properties.budget_abort_cap_reason = 'free_monthly_exhausted') AS interrupted,
    groupArrayIf(timestamp, event = 'subscription_started'
      AND properties.conversion_type = 'free_to_paid') AS payments,
    groupArrayIf(tuple(timestamp, coalesce(toFloat(properties.attributed_revenue_dollars), 0)),
      event = 'subscription_started' AND properties.conversion_type = 'free_to_paid') AS revenue
  FROM events
  WHERE timestamp >= toDateTime('2026-09-14 00:00:00') AND timestamp < now()
    AND event IN ('free_monthly_budget_exposed', 'free_response_completed',
      'hackerai-usage_cost', 'hackerai-agent_run', 'subscription_started')
  GROUP BY distinct_id
  HAVING exposures > 0
), outcomes AS (
  SELECT
    variant, exposed_at, variants_seen,
    exposed_at + INTERVAL 1 DAY <= now() AS mature24h,
    exposed_at + INTERVAL 2 DAY <= now() AS mature48h,
    exposed_at + INTERVAL 7 DAY <= now() AS mature7d,
    arrayExists(t -> t >= exposed_at AND t < exposed_at + INTERVAL 1 DAY, completions) AS completed24h,
    arrayExists(t -> t >= exposed_at + INTERVAL 1 DAY AND t < exposed_at + INTERVAL 2 DAY, usage_times) AS returned_day2,
    arrayExists(t -> t >= exposed_at + INTERVAL 6 DAY AND t < exposed_at + INTERVAL 7 DAY, usage_times) AS returned_day7,
    arrayExists(t -> t >= exposed_at AND t < exposed_at + INTERVAL 7 DAY, payments) AS paid7d,
    arrayCount(t -> t >= exposed_at AND t < exposed_at + INTERVAL 7 DAY, agent_runs) AS runs7d,
    arrayCount(t -> t >= exposed_at AND t < exposed_at + INTERVAL 7 DAY, interrupted) AS interrupted7d,
    arraySum(arrayMap(x -> if(x.1 >= exposed_at AND x.1 < exposed_at + INTERVAL 1 DAY, x.2, 0), costs)) AS cost24h,
    arraySum(arrayMap(x -> if(x.1 >= exposed_at AND x.1 < exposed_at + INTERVAL 7 DAY, x.2, 0), costs)) AS cost7d,
    arraySum(arrayMap(x -> if(x.1 >= exposed_at AND x.1 < exposed_at + INTERVAL 7 DAY, x.2, 0), revenue)) AS revenue7d
  FROM accounts
  WHERE variant IN ('control', 'test')
)
SELECT
  variant, count() AS exposed_accounts, countIf(variants_seen > 1) AS crossover_accounts,
  min(exposed_at) AS first_exposure, max(exposed_at) AS latest_exposure,
  countIf(mature24h) AS mature24h_accounts,
  countIf(mature24h AND completed24h) AS completed24h_accounts,
  100.0 * completed24h_accounts / nullIf(mature24h_accounts, 0) AS completed24h_pct,
  sumIf(cost24h, mature24h) / nullIf(mature24h_accounts, 0) AS cost_per_account24h,
  countIf(mature48h) AS mature48h_accounts,
  countIf(mature48h AND returned_day2) AS returned_day2_accounts,
  100.0 * returned_day2_accounts / nullIf(mature48h_accounts, 0) AS returned_day2_pct,
  countIf(mature7d) AS mature7d_accounts,
  countIf(mature7d AND returned_day7) AS returned_day7_accounts,
  countIf(mature7d AND paid7d) AS paid7d_accounts,
  100.0 * paid7d_accounts / nullIf(mature7d_accounts, 0) AS paid7d_pct,
  sumIf(runs7d, mature7d) AS agent_runs7d,
  sumIf(interrupted7d, mature7d) AS interrupted_runs7d,
  100.0 * interrupted_runs7d / nullIf(agent_runs7d, 0) AS interrupted_run_pct,
  sumIf(cost7d, mature7d) / nullIf(mature7d_accounts, 0) AS free_cost_per_account7d,
  sumIf(revenue7d, mature7d) / nullIf(mature7d_accounts, 0) AS attributed_revenue_per_account7d,
  attributed_revenue_per_account7d - free_cost_per_account7d AS revenue_less_free_cost_per_account7d
FROM outcomes
GROUP BY variant
ORDER BY variant
-- Compare test minus control cost/revenue per exposed account, never raw totals
-- or cost per usage event. Revenue less free cost excludes paid serving costs,
-- refunds, payment fees and later renewals; it is not net profit or lifetime value.
