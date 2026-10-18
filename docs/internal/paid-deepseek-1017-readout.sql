-- HAC-181: freeze both UTC bounds to the live enrollment/readout window.
-- Noncanonical experiment-specific aggregate. Run separately in 144137 and
-- 401167; never combine Preview QA and Production. New outcome instrumentation
-- must be ingested before running. Apply Production internal-account exclusion
-- to source rows before analysis. Output contains no customer content.
WITH request_events AS (
  SELECT
    distinct_id,
    properties.experiment_request_id AS request_id,
    countIf(event = 'flash_routing_experiment_exposed') AS exposures,
    argMinIf(properties.experiment_variant, timestamp,
      event = 'flash_routing_experiment_exposed') AS variant,
    argMinIf(properties.mode, timestamp,
      event = 'flash_routing_experiment_exposed') AS mode,
    argMinIf(properties.subscription_tier, timestamp,
      event = 'flash_routing_experiment_exposed') AS tier,
    argMinIf(properties.experiment_selector, timestamp,
      event = 'flash_routing_experiment_exposed') AS selector,
    argMinIf(properties.experiment_baseline_model, timestamp,
      event = 'flash_routing_experiment_exposed') AS baseline,
    countIf(event = 'paid_model_response_outcome') AS outcomes,
    argMaxIf(properties.message_id, timestamp,
      event = 'paid_model_response_outcome') AS final_message_id,
    argMaxIf(properties.outcome, timestamp,
      event = 'paid_model_response_outcome') AS outcome,
    argMaxIf(properties.natural_completion, timestamp,
      event = 'paid_model_response_outcome') AS completed,
    argMaxIf(properties.has_response_content, timestamp,
      event = 'paid_model_response_outcome') AS has_content,
    argMaxIf(properties.fallback_served, timestamp,
      event = 'paid_model_response_outcome') AS fallback,
    argMaxIf(properties.sandbox_type, timestamp,
      event = 'paid_model_response_outcome') AS transport,
    argMaxIf(toFloat(properties.duration_ms), timestamp,
      event = 'paid_model_response_outcome') AS duration_ms,
    argMaxIf(toFloat(properties.time_to_first_chunk_ms), timestamp,
      event = 'paid_model_response_outcome') AS first_chunk_ms,
    countIf(event = 'hackerai-usage_cost') AS cost_records,
    sumIf(toFloat(properties.cost_dollars),
      event = 'hackerai-usage_cost') AS cost_dollars,
    sumIf(toFloat(properties.model_cost_dollars),
      event = 'hackerai-usage_cost') AS model_cost_dollars
  FROM events
  WHERE timestamp >= toDateTime('2026-10-18 00:00:00')
    AND timestamp < toDateTime('2026-10-26 00:00:00')
    AND event IN ('flash_routing_experiment_exposed',
      'paid_model_response_outcome', 'hackerai-usage_cost')
    AND properties.experiment_key = 'paid_pro_auto_deepseek_1017_v1'
    AND notEmpty(properties.experiment_request_id)
  GROUP BY distinct_id, request_id
), feedback AS (
  SELECT distinct_id, properties.message_id AS message_id,
    count() AS feedback_events,
    argMax(properties.feedback_type, timestamp) AS latest_feedback
  FROM events
  WHERE timestamp >= toDateTime('2026-10-18 00:00:00')
    AND timestamp < toDateTime('2026-10-26 00:00:00')
    AND event = 'message_feedback_submitted'
  GROUP BY distinct_id, message_id
)
SELECT r.variant, r.mode, r.tier, r.selector, r.baseline, r.transport,
  uniqExact(r.distinct_id) AS users,
  count() AS exposed_requests,
  countIf(r.exposures > 1) AS duplicate_exposure_requests,
  countIf(r.outcomes = 0) AS missing_terminal_requests,
  countIf(r.outcomes > 1) AS duplicate_terminal_requests,
  countIf(r.completed = true AND r.outcomes > 0) AS natural_completions,
  countIf(r.outcome = 'error') AS errors,
  countIf(r.outcome = 'aborted') AS canceled,
  countIf(r.has_content = false AND r.outcomes > 0) AS empty_responses,
  countIf(r.fallback = true) AS fallback_requests,
  countIf(r.cost_records = 0) AS missing_cost_requests,
  sum(r.cost_dollars) AS known_total_cost_dollars,
  sum(r.model_cost_dollars) AS model_cost_dollars,
  sum(r.cost_dollars) / nullIf(countIf(r.completed = true), 0) AS cost_per_completion,
  quantileIf(0.5)(r.duration_ms, r.outcomes > 0 AND r.duration_ms IS NOT NULL) AS duration_p50_ms,
  quantileIf(0.95)(r.duration_ms, r.outcomes > 0 AND r.duration_ms IS NOT NULL) AS duration_p95_ms,
  quantileIf(0.5)(r.first_chunk_ms, r.outcomes > 0 AND r.first_chunk_ms IS NOT NULL) AS first_chunk_p50_ms,
  quantileIf(0.95)(r.first_chunk_ms, r.outcomes > 0 AND r.first_chunk_ms IS NOT NULL) AS first_chunk_p95_ms,
  countIf(f.feedback_events > 0) AS feedback_requests,
  countIf(f.latest_feedback = 'positive') AS positive_feedback,
  countIf(f.latest_feedback = 'negative') AS negative_feedback
FROM request_events r
LEFT JOIN feedback f ON r.distinct_id = f.distinct_id
  AND coalesce(nullIf(r.final_message_id, ''), r.request_id) = f.message_id
WHERE r.exposures > 0
GROUP BY r.variant, r.mode, r.tier, r.selector, r.baseline, r.transport
ORDER BY r.mode, r.tier, r.selector, r.variant


-- Run separately: person-level allocation and crossover check for SRM.
WITH users AS (
  SELECT distinct_id,
    argMin(properties.experiment_variant, timestamp) AS first_variant,
    uniqExact(properties.experiment_variant) AS variants_seen
  FROM events
  WHERE timestamp >= toDateTime('2026-10-18 00:00:00')
    AND timestamp < toDateTime('2026-10-26 00:00:00')
    AND event = 'flash_routing_experiment_exposed'
    AND properties.experiment_key = 'paid_pro_auto_deepseek_1017_v1'
  GROUP BY distinct_id
)
SELECT first_variant, variants_seen, count() AS users
FROM users
GROUP BY first_variant, variants_seen
ORDER BY first_variant, variants_seen
