-- PostHog HogQL, run separately in Preview 401167 and Production 144137.
-- Replace cohort bounds and as_of with a fixed UTC readout cutoff; exclude the
-- recorded internal allowlist before a public readout. No prompt/content fields.
-- This is the analytics-observed cohort. Reconcile with durable Convex surveys:
-- absent delivery is missing telemetry, never a failed task or churn.
WITH
cohort AS (
    SELECT distinct_id, properties.survey_request_id AS request_id,
        argMin(toFloat(properties.selected_at), timestamp) AS selected_at,
        argMin(toFloat(properties.expires_at), timestamp) AS expires_at,
        argMin(properties.stripe_subscription_id, timestamp) AS subscription_id,
        argMin(properties.paid_start_invoice_id, timestamp) AS initial_invoice_id,
        argMin(toFloatOrNull(toString(properties.baseline_renewal_at)), timestamp) AS renewal_due,
        argMin(properties.billing_interval, timestamp) AS billing_interval
    FROM events
    WHERE event = 'task_outcome_survey_selected'
      AND properties.survey_kind = 'new_paid'
      AND timestamp >= toDateTime('2026-09-15 00:00:00', 'UTC')
      AND timestamp < toDateTime('2026-09-22 00:00:00', 'UTC')
    GROUP BY distinct_id, request_id
),
activity AS (
    SELECT distinct_id, event, properties,
        toUnixTimestamp(timestamp) * 1000 AS at
    FROM events
    WHERE event IN ('task_outcome_survey_shown', 'task_outcome_survey_answered',
                    'task_outcome_survey_dismissed', 'chat_user_submission', 'invoice_paid')
      AND timestamp >= toDateTime('2026-09-15 00:00:00', 'UTC')
      AND timestamp < toDateTime('2026-11-01 00:00:00', 'UTC')
),
per_user AS (
    SELECT c.distinct_id, c.request_id, c.billing_interval, c.selected_at,
        c.expires_at, c.renewal_due,
        countIf(a.event = 'task_outcome_survey_shown' AND a.properties.survey_request_id = c.request_id) > 0 AS viewed,
        countIf(a.event = 'task_outcome_survey_dismissed' AND a.properties.survey_request_id = c.request_id) > 0 AS dismissed,
        ifNull(anyIf(toString(a.properties.answer), a.event = 'task_outcome_survey_answered' AND a.properties.survey_request_id = c.request_id), '') AS answer,
        countIf(a.event = 'chat_user_submission' AND a.properties.definition_version = 1
            AND a.at >= c.selected_at + 86400000 AND a.at < c.selected_at + 172800000) > 0 AS d1,
        countIf(a.event = 'chat_user_submission' AND a.properties.definition_version = 1
            AND a.at >= c.selected_at + 604800000 AND a.at < c.selected_at + 691200000) > 0 AS d7,
        countIf(a.event = 'invoice_paid' AND a.properties.billing_reason = 'subscription_cycle'
            AND a.properties.stripe_subscription_id = c.subscription_id
            AND a.properties.stripe_invoice_id != c.initial_invoice_id
            AND toFloat(a.properties.amount_paid_dollars) > 0
            AND toFloat(a.properties.billing_period_start) = c.renewal_due
            AND toFloat(a.properties.invoice_paid_at) >= c.renewal_due
            AND toFloat(a.properties.invoice_paid_at) <= c.renewal_due + 604800000) > 0 AS paid_within_grace
    FROM cohort c LEFT JOIN activity a ON a.distinct_id = c.distinct_id
    GROUP BY c.distinct_id, c.request_id, c.billing_interval, c.selected_at, c.expires_at, c.renewal_due
)
SELECT billing_interval,
    count() AS selected_users,
    countIf(viewed) AS viewed_users,
    countIf(answer = 'solved') AS solved,
    countIf(answer = 'helpful') AS helpful_still_working,
    countIf(answer = 'no') AS did_not_help,
    countIf(answer = 'not_checked') AS not_checked,
    countIf(answer NOT IN ('solved', 'helpful', 'no', 'not_checked') AND dismissed) AS dismissed_unanswered,
    countIf(answer NOT IN ('solved', 'helpful', 'no', 'not_checked') AND NOT dismissed AND expires_at > toUnixTimestamp(toDateTime('2026-11-01 00:00:00', 'UTC')) * 1000) AS pending_unanswered,
    countIf(answer NOT IN ('solved', 'helpful', 'no', 'not_checked') AND NOT dismissed AND NOT viewed AND expires_at <= toUnixTimestamp(toDateTime('2026-11-01 00:00:00', 'UTC')) * 1000) AS expired_without_observed_view,
    countIf(answer NOT IN ('solved', 'helpful', 'no', 'not_checked') AND NOT dismissed AND viewed AND expires_at <= toUnixTimestamp(toDateTime('2026-11-01 00:00:00', 'UTC')) * 1000) AS expired_viewed_unanswered,
    countIf(selected_at + 172800000 <= toUnixTimestamp(toDateTime('2026-11-01 00:00:00', 'UTC')) * 1000) AS d1_mature,
    countIf(d1 AND selected_at + 172800000 <= toUnixTimestamp(toDateTime('2026-11-01 00:00:00', 'UTC')) * 1000) AS d1_returned,
    countIf(selected_at + 691200000 <= toUnixTimestamp(toDateTime('2026-11-01 00:00:00', 'UTC')) * 1000) AS d7_mature,
    countIf(d7 AND selected_at + 691200000 <= toUnixTimestamp(toDateTime('2026-11-01 00:00:00', 'UTC')) * 1000) AS d7_returned,
    countIf(renewal_due IS NULL) AS renewal_date_unknown,
    countIf(renewal_due + 604800000 <= toUnixTimestamp(toDateTime('2026-11-01 00:00:00', 'UTC')) * 1000) AS renewal_mature,
    countIf(paid_within_grace AND renewal_due + 604800000 <= toUnixTimestamp(toDateTime('2026-11-01 00:00:00', 'UTC')) * 1000) AS paid_renewal_within_grace
FROM per_user
GROUP BY billing_interval
