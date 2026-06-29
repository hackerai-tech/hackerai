# Free Agent MiniMax M3 Canary

## Evaluation

Evaluated for HAC-41 on 2026-06-29.

Paid soak window: 2026-06-26 16:45 America/New_York through 2026-06-29 08:22 America/New_York.

Pre-change thresholds:

- At least 48 hours of paid soak and at least 1,000 paid Agent MiniMax cost events.
- Paid Agent error rate no higher than 0.5% and not worse than the pre-rollout baseline.
- Paid Agent success rate within 2 percentage points of the pre-rollout baseline.
- Kimi/Grok fallback-like usage below 10% of paid MiniMax/Kimi/Grok Agent usage.
- No meaningful support-ticket or cancellation-reason increase for cost/reliability.
- Full free rollout only if projected free Agent provider cost is near neutral. If projected free cost rises materially, use a percentage canary.

Observed at evaluation time:

- Paid MiniMax Agent usage: 1,457 cost events, 97 paid users, $181.17 usage cost.
- Paid Agent outcomes after rollout: 14,255 runs, 88.40% success, 0.056% error.
- Pre-rollout paid Agent baseline: 17,592 runs, 88.97% success, 0.176% error.
- Fallback-like paid Agent usage after rollout: 8.54% Kimi/Grok share across MiniMax/Kimi/Grok rows.
- Support tickets in the paid soak window: 0.
- Cancellation reasons in the paid soak window: 6 `too_expensive`, 4 `hit_usage_limits`, 31 total.
- Free Agent projection over the same post-rollout window: current free route $111.55, projected MiniMax $294.44, or 2.64x current cost.

Decision: run a canary instead of flipping all free Agent traffic. Paid MiniMax M3 is healthy enough to expose to free users, but projected free-route cost is materially higher than the current free route.

## Rollout

Set `FREE_AGENT_MINIMAX_M3_ROLLOUT_PERCENT` to the desired integer percentage from `0` to `100`.

Suggested first step: `5` for 24 hours, then `10` if Agent outcomes and free cost remain healthy.

Rollback: set `FREE_AGENT_MINIMAX_M3_ROLLOUT_PERCENT=0` and redeploy. No data migration is required; non-canary free Agent traffic remains on `agent-model-free`.

## Monitoring Queries

Replace `{{rollout_start}}` with the deployment timestamp and `{{rollout_start_date}}` with the deployment date in `YYYY-MM-DD` format.

Paid/free model cost mix:

```sql
SELECT
  properties.subscription_tier AS tier,
  properties.model AS model,
  count() AS cost_events,
  count(DISTINCT person_id) AS users,
  sum(toFloat(properties.cost_dollars)) AS cost_dollars,
  sum(toFloat(properties.model_cost_dollars)) AS model_cost_dollars,
  sum(toFloat(properties.input_tokens)) AS input_tokens,
  sum(toFloat(properties.output_tokens)) AS output_tokens
FROM events
WHERE event = 'hackerai-usage_cost'
  AND timestamp >= toDateTime('{{rollout_start}}', 'America/New_York')
  AND properties.mode = 'agent'
GROUP BY tier, model
ORDER BY cost_events DESC
```

Agent outcome rates:

```sql
SELECT
  properties.subscription_tier AS tier,
  properties.outcome AS outcome,
  properties.finish_reason AS finish_reason,
  count() AS runs,
  count(DISTINCT person_id) AS users
FROM events
WHERE event = 'hackerai-agent_run'
  AND timestamp >= toDateTime('{{rollout_start}}', 'America/New_York')
  AND properties.mode = 'agent'
GROUP BY tier, outcome, finish_reason
ORDER BY tier, runs DESC
```

Cancellation reason watch:

```sql
SELECT
  properties.reason_category AS reason_category,
  properties.subscription_tier AS tier,
  count() AS selections,
  count(DISTINCT person_id) AS users
FROM events
WHERE event = 'cancellation_reason_selected'
  AND timestamp >= toDateTime('{{rollout_start}}', 'America/New_York')
GROUP BY reason_category, tier
ORDER BY selections DESC
```

Convex daily unit economics:

```sql
SELECT
  day,
  entity_type,
  sum(usage_request_count) AS usage_requests,
  sum(total_cost_dollars) AS total_cost_dollars,
  sum(model_cost_dollars) AS model_cost_dollars,
  sum(non_model_cost_dollars) AS non_model_cost_dollars,
  sum(gross_profit_dollars) AS gross_profit_dollars
FROM convex_unit_economics_daily
WHERE day >= '{{rollout_start_date}}'
GROUP BY day, entity_type
ORDER BY day DESC, entity_type
```
