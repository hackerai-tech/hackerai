-- PostHog HogQL, production 144137 (Preview: 401167).
-- Seven-day signup cohorts; outcomes are read through now, not cohort end.
-- Distinct WorkOS accounts, deliberately not canonical mailbox identities.
-- Activation metrics are NULL until the entire weekly cohort has coverage.
WITH
  now() - INTERVAL 42 DAY AS scan_start,
  now() - INTERVAL 7 DAY AS mature_before,
  (
    SELECT min(timestamp) FROM events
    WHERE event = 'free_response_completed'
      AND properties.activation_definition_version = 1
      AND timestamp >= scan_start AND timestamp < now()
  ) AS activation_observed_since
SELECT
  toStartOfWeek(signup_at, 1) AS signup_week,
  count() AS raw_accounts_created,
  countIf(paid_at >= signup_at AND paid_at < signup_at + INTERVAL 7 DAY) AS paid_accounts_7d,
  round(100.0 * paid_accounts_7d / nullIf(raw_accounts_created, 0), 3) AS raw_signup_to_paid_pct,
  if(activation_observed_since > toDateTime('2020-01-01') AND min(signup_at) >= activation_observed_since,
     countIf(activated_at >= signup_at AND activated_at < signup_at + INTERVAL 7 DAY), NULL) AS activated_accounts_7d,
  if(activated_accounts_7d IS NOT NULL,
     countIf(activated_at >= signup_at AND activated_at < signup_at + INTERVAL 7 DAY
       AND paid_at >= activated_at AND paid_at < signup_at + INTERVAL 7 DAY), NULL) AS activated_then_paid_accounts_7d,
  round(100.0 * activated_accounts_7d / nullIf(raw_accounts_created, 0), 3) AS activation_pct,
  round(100.0 * activated_then_paid_accounts_7d / nullIf(activated_accounts_7d, 0), 3) AS activated_to_paid_pct,
  activation_observed_since
FROM (
  SELECT distinct_id,
    minIf(timestamp, event = 'user_signed_up') AS signup_at,
    minIf(timestamp, event = 'free_response_completed' AND properties.activation_definition_version = 1) AS activated_at,
    minIf(timestamp, event = 'subscription_started'
      AND properties.conversion_type = 'free_to_paid') AS paid_at,
    countIf(event = 'user_signed_up') AS signup_events
  FROM events
  WHERE timestamp >= scan_start AND timestamp < now()
    AND event IN ('user_signed_up', 'free_response_completed', 'subscription_started')
  GROUP BY distinct_id
)
WHERE signup_events > 0 AND signup_at < mature_before
GROUP BY signup_week
ORDER BY signup_week DESC
