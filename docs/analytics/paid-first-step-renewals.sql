-- PostHog HogQL. Frozen subscriber denominator, including pre-renewal endings.
-- Confirm billing-source freshness and invoice property coverage before interpretation.
-- No payment event is "unobserved", not proof of churn. Annual cohorts stay separate.
WITH enrollments AS (
  SELECT distinct_id,
    argMin(properties.experiment_variant, timestamp) AS variant,
    argMin(properties.baseline_stripe_subscription_id, timestamp) AS subscription_id,
    argMin(toFloat(properties.paid_first_step_enrolled_at), timestamp) AS enrolled_at,
    argMin(toFloat(properties.baseline_renewal_at), timestamp) AS renewal_at,
    argMin(properties.baseline_billing_interval, timestamp) AS billing_interval,
    argMin(properties.baseline_billing_interval_count, timestamp) AS interval_count,
    argMin(properties.baseline_cancel_at_period_end, timestamp) AS pending_cancel,
    uniqExact(properties.experiment_variant) AS variants
  FROM events
  WHERE timestamp >= toDateTime('2026-09-17 00:00:00') AND timestamp < now()
    AND event = 'abliterated_model_eligible'
    AND properties.experiment_key = 'abliterated_paid_first_step_v1'
    AND properties.baseline_stripe_subscription_id IS NOT NULL
  GROUP BY distinct_id
), billing AS (
  SELECT properties.stripe_subscription_id AS subscription_id,
    groupArrayIf(tuple(toFloat(properties.invoice_paid_at), toFloat(properties.billing_period_start)),
      event = 'invoice_paid' AND properties.billing_reason = 'subscription_cycle'
      AND toFloat(properties.amount_paid_dollars) > 0) AS payments,
    groupArrayIf(toFloat(properties.occurred_at), event = 'subscription_cancelled') AS endings
  FROM events
  WHERE timestamp >= toDateTime('2026-09-17 00:00:00') AND timestamp < now()
    AND event IN ('invoice_paid', 'subscription_cancelled')
    AND properties.stripe_subscription_id IS NOT NULL
  GROUP BY subscription_id
), outcomes AS (
  SELECT e.*,
    toUnixTimestamp(now()) * 1000 >= e.renewal_at + 604800000 AS mature,
    arrayExists(p -> p.1 >= e.enrolled_at AND p.1 <= e.renewal_at + 604800000
      AND abs(p.2 - e.renewal_at) <= 86400000, b.payments) AS observed_renewal,
    arrayExists(t -> t >= e.enrolled_at AND t <= e.renewal_at, b.endings) AS ended_before_renewal
  FROM enrollments e LEFT JOIN billing b ON e.subscription_id = b.subscription_id
)
SELECT variant, billing_interval, interval_count, pending_cancel,
  count() AS enrolled_subscribers, countIf(variants > 1) AS crossover_users,
  countIf(NOT mature) AS immature_subscribers, countIf(mature) AS mature_subscribers,
  countIf(mature AND observed_renewal) AS confirmed_renewals,
  countIf(mature AND ended_before_renewal AND NOT observed_renewal) AS confirmed_pre_renewal_endings,
  countIf(mature AND NOT observed_renewal AND NOT ended_before_renewal) AS unobserved_renewals_needing_billing_reconciliation,
  countIf(mature AND observed_renewal) / nullIf(countIf(mature), 0) AS observed_renewal_share
FROM outcomes GROUP BY variant, billing_interval, interval_count, pending_cancel
ORDER BY variant, billing_interval, interval_count, pending_cancel
