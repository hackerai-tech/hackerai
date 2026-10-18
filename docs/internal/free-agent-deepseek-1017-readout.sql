-- HAC-184. Noncanonical mature-user comparison, never pool Preview/Production.
-- Replace both UTC placeholders with the verified launch and a frozen readout.
-- Exclude every known QA distinct_id in the source WHERE before running.
-- Compare full seven-day cohorts. A live dashboard is an immature diagnostic.
WITH accounts AS (
  SELECT
    distinct_id,
    minIf(timestamp, event = 'flash_routing_experiment_exposed'
      AND properties.experiment_key = 'free_agent_deepseek_1017_conversion_v1') AS exposed_at,
    argMinIf(properties.experiment_variant, timestamp,
      event = 'flash_routing_experiment_exposed'
      AND properties.experiment_key = 'free_agent_deepseek_1017_conversion_v1') AS variant,
    uniqExactIf(properties.experiment_variant,
      event = 'flash_routing_experiment_exposed'
      AND properties.experiment_key = 'free_agent_deepseek_1017_conversion_v1') AS variants_seen,
    countIf(event = 'flash_routing_experiment_exposed'
      AND properties.experiment_key = 'free_agent_deepseek_1017_conversion_v1') AS exposures,
    groupArrayIf(timestamp, event = 'subscription_started'
      AND properties.conversion_type = 'free_to_paid'
      AND toFloat(properties.invoice_amount_paid_dollars) > 0) AS payments,
    groupArrayIf(tuple(timestamp, coalesce(toFloat(properties.cost_dollars), 0),
      coalesce(toFloat(properties.model_cost_dollars), 0),
      properties.cost_dollars IS NOT NULL,
      properties.model_cost_dollars IS NOT NULL),
      event = 'hackerai-usage_cost' AND properties.mode = 'agent'
      AND properties.subscription_tier = 'free') AS costs,
    argMinIf(properties.free_agent_budget_experiment_variant, timestamp,
      event = 'hackerai-usage_cost' AND properties.mode = 'agent'
      AND properties.subscription_tier = 'free'
      AND notEmpty(properties.free_agent_budget_experiment_variant)) AS budget_variant
  FROM events
  WHERE timestamp >= toDateTime('{{launch_utc}}', 'UTC')
    AND timestamp < toDateTime('{{as_of_utc}}', 'UTC')
    AND event IN ('flash_routing_experiment_exposed',
      'subscription_started', 'hackerai-usage_cost')
    AND distinct_id != 'user_01JXWCBJPZKR4J7E7V1E0WM6MZ'
  GROUP BY distinct_id
  HAVING exposures > 0
), user_outcomes AS (
  SELECT
    variant, variants_seen, budget_variant, exposed_at,
    exposed_at + INTERVAL 7 DAY <= toDateTime('{{as_of_utc}}', 'UTC') AS mature,
    arrayExists(t -> t >= exposed_at AND t < exposed_at + INTERVAL 7 DAY,
      payments) AS paid7d,
    arrayCount(c -> c.1 >= exposed_at AND c.1 < exposed_at + INTERVAL 7 DAY,
      costs) AS cost_records7d,
    arrayExists(c -> c.1 >= exposed_at AND c.1 < exposed_at + INTERVAL 7 DAY
      AND NOT c.4, costs) AS unknown_cost7d,
    arrayExists(c -> c.1 >= exposed_at AND c.1 < exposed_at + INTERVAL 7 DAY
      AND NOT c.5, costs) AS unknown_model_cost7d,
    arraySum(arrayMap(c -> if(c.1 >= exposed_at
      AND c.1 < exposed_at + INTERVAL 7 DAY, c.2, 0), costs)) AS cost7d,
    arraySum(arrayMap(c -> if(c.1 >= exposed_at
      AND c.1 < exposed_at + INTERVAL 7 DAY, c.3, 0), costs)) AS model_cost7d
  FROM accounts
  WHERE variant IN ('control', 'test')
)
SELECT variant, budget_variant,
  count() AS exposed_users,
  countIf(variants_seen > 1) AS crossover_users,
  countIf(mature AND variants_seen = 1) AS mature_users,
  countIf(mature AND variants_seen = 1 AND paid7d) AS converted_users,
  100.0 * converted_users / nullIf(mature_users, 0) AS conversion_pct7d,
  countIf(mature AND variants_seen = 1 AND cost_records7d = 0) AS missing_cost_users,
  countIf(mature AND variants_seen = 1 AND unknown_cost7d) AS unknown_cost_users,
  countIf(mature AND variants_seen = 1 AND unknown_model_cost7d) AS unknown_model_cost_users,
  sumIf(cost7d, mature AND variants_seen = 1) AS known_free_agent_cost7d,
  known_free_agent_cost7d / nullIf(mature_users, 0) AS cost_per_exposed_user7d,
  sumIf(model_cost7d, mature AND variants_seen = 1) /
    nullIf(mature_users, 0) AS model_cost_per_exposed_user7d,
  known_free_agent_cost7d / nullIf(converted_users, 0) AS cost_per_converted_user7d
FROM user_outcomes
GROUP BY variant, budget_variant
ORDER BY budget_variant, variant

-- Zero payments remain in the denominator. Crossover users are reported and
-- excluded from primary outcomes, matching the native experiment policy.
-- Paid starts are counted once per user, not per invoice or event. All Free
-- Agent cost after exposure is included, even on non-enrolled image requests;
-- paid serving costs after upgrade are excluded. Unknown costs are not zero.
-- Before a decision, reconcile duplicate/missing request costs using stable
-- experiment_request_id/trigger_run_id and the free_agent_model_response_outcome
-- terminal event. Do not interpret lower observed cost with poorer coverage as
-- a saving. Use the paid experiment's request-join pattern for completion,
-- latency and feedback, replacing its key/outcome event with this test's values.
