-- HogQL. Replace UTC bounds and internal test IDs before running independently
-- in Preview 401167 / Production 144137. Do not compare these environments.
-- Keep all enrolled requests, including missing/failed outcomes. First user
-- assignment owns the analysis arm; crossovers remain visible, not excluded.
WITH requests AS (
    SELECT distinct_id, toString(properties.experiment_request_id) AS request_id,
        min(timestamp) AS enrolled_at,
        argMin(toString(properties.experiment_variant), timestamp) AS assigned_arm,
        argMin(toString(properties.mode), timestamp) AS mode
    FROM events
    WHERE event = 'abliterated_model_eligible'
      AND properties.experiment_key = 'abliterated_short_followup_v1'
      AND properties.followup_measurement_version = 1
      AND properties.experiment_variant IN ('control', 'test')
      AND timestamp >= toDateTime('{activation_utc}', 'UTC')
      AND timestamp < toDateTime('{cohort_end_utc}', 'UTC')
      AND distinct_id NOT IN ({internal_test_distinct_ids})
    GROUP BY distinct_id, request_id
), users AS (
    SELECT distinct_id, argMin(assigned_arm, enrolled_at) AS arm
    FROM requests GROUP BY distinct_id
), outcomes AS (
    SELECT distinct_id, toString(properties.experiment_request_id) AS request_id,
        count() AS deliveries,
        argMax(toString(properties.outcome), timestamp) AS outcome,
        argMax(properties.has_response_content, timestamp) AS has_content,
        argMax(toFloat(properties.provider_attempt_count), timestamp) AS attempts,
        argMax(toFloat(properties.provider_usage_reported_count), timestamp) AS measured_attempts,
        argMax(toFloat(properties.provider_estimated_cost_dollars), timestamp) AS provider_cost,
        argMax(toFloat(properties.provider_duration_ms), timestamp) AS provider_ms,
        argMax(properties.fallback_served, timestamp) AS fallback
    FROM events
    WHERE event = 'abliterated_model_response_outcome'
      AND properties.experiment_key = 'abliterated_short_followup_v1'
      AND timestamp >= toDateTime('{activation_utc}', 'UTC')
      AND timestamp < toDateTime('{as_of_utc}', 'UTC')
    GROUP BY distinct_id, request_id
), costs AS (
    -- This event is the cumulative request settlement, not an attempt charge.
    -- Last snapshot prevents duplicate delivery from increasing spend.
    SELECT distinct_id, toString(properties.experiment_request_id) AS request_id,
        count() AS deliveries,
        argMax(toFloat(properties.cost_dollars), timestamp) AS cost,
        argMax(toFloat(properties.input_tokens), timestamp) AS input_tokens,
        argMax(toFloat(properties.cache_read_tokens), timestamp) AS cache_tokens
    FROM events
    WHERE event = 'hackerai-usage_cost'
      AND properties.experiment_key = 'abliterated_short_followup_v1'
      AND properties.cost_accounting_status = 'recorded'
      AND timestamp >= toDateTime('{activation_utc}', 'UTC')
      AND timestamp < toDateTime('{as_of_utc}', 'UTC')
    GROUP BY distinct_id, request_id
), exposures AS (
    SELECT distinct_id, toString(properties.experiment_request_id) AS request_id,
        count() AS deliveries,
        argMin(toString(properties.response_model), timestamp) AS served_model
    FROM events
    WHERE event = 'abliterated_model_exposed'
      AND properties.experiment_key = 'abliterated_short_followup_v1'
      AND timestamp >= toDateTime('{activation_utc}', 'UTC')
      AND timestamp < toDateTime('{as_of_utc}', 'UTC')
    GROUP BY distinct_id, request_id
)
SELECT u.arm, r.mode, count() AS enrolled_requests,
    uniqExact(r.distinct_id) AS enrolled_users,
    countIf(r.assigned_arm != u.arm) AS crossover_requests,
    countIf(e.deliveries > 0) AS exposed_requests,
    countIf(e.served_model = 'abliterated-model') AS abliteration_first_exposures,
    countIf(o.deliveries > 0) AS final_outcomes,
    countIf(o.outcome = 'success' AND o.has_content = true) AS nonempty_successes,
    countIf(o.outcome != 'success' AND o.deliveries > 0) AS unsuccessful,
    countIf(ifNull(o.deliveries, 0) = 0) AS missing_or_pending,
    countIf(ifNull(o.deliveries, 0) = 0 AND r.enrolled_at <
        toDateTime('{as_of_utc}', 'UTC') - INTERVAL 1 HOUR) AS missing_after_one_hour,
    countIf(o.fallback = true) AS fallback_requests,
    countIf(o.attempts > o.measured_attempts) AS incomplete_provider_usage,
    countIf(c.deliveries > 0) AS cost_covered_requests,
    countIf(c.deliveries > 1) AS repeated_cost_snapshots,
    sum(c.cost) AS observed_total_cost,
    sum(c.cost) / nullIf(count(), 0) AS observed_cost_per_enrolled,
    quantileIf(0.95)(c.cost, c.deliveries > 0) AS p95_known_request_cost,
    sum(o.provider_cost) AS observed_generation_cost,
    quantileIf(0.95)(o.provider_ms, o.deliveries > 0) AS p95_provider_ms,
    sum(c.cache_tokens) / nullIf(sum(c.input_tokens), 0) AS cache_read_fraction
FROM requests r
INNER JOIN users u ON r.distinct_id = u.distinct_id
LEFT JOIN outcomes o ON r.distinct_id = o.distinct_id AND r.request_id = o.request_id
LEFT JOIN costs c ON r.distinct_id = c.distinct_id AND r.request_id = c.request_id
LEFT JOIN exposures e ON r.distinct_id = e.distinct_id AND r.request_id = e.request_id
GROUP BY u.arm, r.mode
