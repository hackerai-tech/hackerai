-- PostHog HogQL. Request-anchored, not successful-response-only.
-- Final outcomes may arrive late; missing outcomes remain in the denominator.
WITH requests AS (
  SELECT distinct_id, properties.experiment_request_id AS request_id,
    argMin(properties.experiment_variant, timestamp) AS variant,
    argMin(properties.mode, timestamp) AS mode,
    max(event = 'abliterated_model_eligible') AS eligible,
    max(event = 'abliterated_model_exposed') AS exposed,
    max(event = 'abliterated_model_response_outcome') AS has_outcome,
    argMaxIf(properties.natural_completion, timestamp, event = 'abliterated_model_response_outcome') = true AS completed,
    argMaxIf(properties.outcome, timestamp, event = 'abliterated_model_response_outcome') AS outcome,
    maxIf(toFloat(properties.provider_priced_cost_dollars), event = 'abliterated_model_response_outcome') AS cost,
    maxIf(toFloat(properties.provider_attempt_count), event = 'abliterated_model_response_outcome') AS attempts,
    maxIf(toFloat(properties.provider_usage_reported_count), event = 'abliterated_model_response_outcome') AS priced_attempts,
    maxIf(toFloat(properties.time_to_exposure_ms), event = 'abliterated_model_exposed') AS first_content_ms,
    maxIf(toFloat(properties.provider_recovery_attempts), event = 'abliterated_model_response_outcome') AS recovery_attempts,
    maxIf(properties.fallback_served = true, event = 'abliterated_model_response_outcome') AS fallback
  FROM events
  WHERE timestamp >= now() - INTERVAL 7 DAY AND timestamp < now()
    AND event IN ('abliterated_model_eligible', 'abliterated_model_exposed', 'abliterated_model_response_outcome')
    AND properties.experiment_key = 'abliterated_paid_first_step_v1'
    AND properties.experiment_request_id IS NOT NULL
  GROUP BY distinct_id, request_id
), users AS (
  SELECT distinct_id, variant, mode,
    count() AS requests, countIf(exposed = 1) AS exposed_requests,
    countIf(has_outcome = 0) AS missing_outcomes,
    countIf(completed) AS completions, countIf(outcome = 'error') AS errors,
    countIf(outcome = 'aborted') AS aborts,
    sum(cost) AS cost, sum(attempts) AS attempts, sum(priced_attempts) AS priced_attempts,
    sum(recovery_attempts) AS recovery_attempts, countIf(fallback) AS fallbacks,
    quantileIf(0.95)(first_content_ms, exposed = 1) AS p95_first_content_ms
  FROM requests WHERE eligible = 1 GROUP BY distinct_id, variant, mode
)
SELECT variant, mode, count() AS users, sum(requests) AS eligible_requests,
  sum(exposed_requests) AS exposed_requests, sum(missing_outcomes) AS missing_outcomes,
  avg(completions / requests) AS user_weighted_completion_rate,
  sum(completions) / sum(requests) AS request_weighted_completion_rate,
  sum(errors) / sum(requests) AS error_rate, sum(aborts) / sum(requests) AS abort_rate,
  sum(cost) AS estimated_provider_cost_usd, sum(cost) / sum(requests) AS cost_per_request,
  sum(cost) / nullIf(sum(completions), 0) AS cost_per_natural_completion,
  sum(priced_attempts) / nullIf(sum(attempts), 0) AS usage_coverage,
  sum(recovery_attempts) AS recovery_attempts, sum(fallbacks) AS fallback_requests,
  avg(p95_first_content_ms) AS mean_user_p95_first_content_ms
FROM users GROUP BY variant, mode ORDER BY variant, mode
