-- Set experiment_key and feedback_phase to one matching pair from
-- experiment-task-outcome-feedback.md; never combine the default and trial.
-- PostHog HogQL. Replace the three UTC bounds with the recorded HAC-120 phase
-- activation, cohort end and readout cutoff. Run independently in each project.
-- Replace internal_test_distinct_ids with a comma-separated list of quoted
-- recorded internal/test IDs before execution; the cohort excludes them upstream.
-- Reconcile every original request ID with Convex; selected telemetry can fail.
WITH cohort AS (
    SELECT distinct_id, toString(properties.survey_request_id) AS request_id,
        argMin(toString(properties.experiment_request_id), timestamp) AS experiment_request_id,
        argMin(toString(properties.experiment_variant), timestamp) AS arm,
        argMin(toString(properties.mode), timestamp) AS mode,
        argMin(toString(properties.selected_model_override), timestamp) AS selector,
        argMin(toString(properties.subscription_tier), timestamp) AS tier,
        argMin(toFloat(properties.expires_at), timestamp) AS expires_at
    FROM events
    WHERE event = 'task_outcome_survey_selected'
      AND properties.survey_kind = 'current_experiment'
      AND properties.feedback_phase = '{feedback_phase}'
      AND properties.experiment_key = '{experiment_key}'
      AND distinct_id NOT IN ({internal_test_distinct_ids})
      AND timestamp >= toDateTime('{activation_utc}', 'UTC')
      AND timestamp < toDateTime('{cohort_end_utc}', 'UTC')
    GROUP BY distinct_id, request_id
), activity AS (
    SELECT distinct_id, toString(properties.survey_request_id) AS request_id,
        countIf(event = 'task_outcome_survey_shown') > 0 AS viewed,
        countIf(event = 'task_outcome_survey_dismissed') > 0 AS dismissed,
        ifNull(argMinIf(toString(properties.answer), timestamp,
            event = 'task_outcome_survey_answered'), '') AS answer
    FROM events
    WHERE event IN ('task_outcome_survey_shown', 'task_outcome_survey_answered',
                    'task_outcome_survey_dismissed')
      -- Cohort selection owns phase attribution. Older view payloads omit it.
      -- The exact authenticated user + immutable request join below prevents
      -- unrelated phases from entering the readout.
      AND timestamp >= toDateTime('{activation_utc}', 'UTC')
      AND timestamp < toDateTime('{as_of_utc}', 'UTC')
    GROUP BY distinct_id, request_id
), per_user AS (
    SELECT c.*, ifNull(a.viewed, false) AS viewed,
        ifNull(a.dismissed, false) AS dismissed, ifNull(a.answer, '') AS answer
    FROM cohort c LEFT JOIN activity a
      ON c.distinct_id = a.distinct_id AND c.request_id = a.request_id
)
SELECT arm, mode, selector, tier, count() AS selected,
    uniqExact(distinct_id) AS selected_users,
    countIf(request_id != experiment_request_id) AS attribution_mismatch,
    countIf(viewed) AS observed_views,
    countIf(answer IN ('solved', 'helpful', 'no', 'not_checked')) AS answered,
    countIf(answer = 'solved') AS solved,
    countIf(answer = 'helpful') AS helpful,
    countIf(answer = 'no') AS no,
    countIf(answer = 'not_checked') AS not_checked,
    countIf(answer = '' AND dismissed) AS dismissed_unanswered,
    countIf(answer = '' AND NOT dismissed AND expires_at >
        toUnixTimestamp(toDateTime('{as_of_utc}', 'UTC')) * 1000) AS pending_unanswered,
    countIf(answer = '' AND NOT dismissed AND expires_at <=
        toUnixTimestamp(toDateTime('{as_of_utc}', 'UTC')) * 1000) AS expired_unanswered,
    countIf(answer IN ('solved', 'helpful', 'no', 'not_checked')) / nullIf(count(), 0) AS response_rate,
    countIf(answer = 'solved') / nullIf(countIf(answer IN ('solved', 'helpful', 'no')), 0) AS solved_fraction,
    countIf(answer = 'solved') / nullIf(count(), 0) AS solved_per_selected
FROM per_user
GROUP BY arm, mode, selector, tier
