# Free Ask DeepSeek Reasoning Experiment

Use this to test whether enabling medium reasoning on free text-only Ask
requests improves activation enough to justify the added latency and cost.

## PostHog setup

Create a PostHog feature flag or experiment with:

- Key: `free_ask_deepseek_reasoning_v1`
- Variants:
  - `control`: no reasoning
  - `reasoning_medium`: DeepSeek V4 Flash with `reasoning.enabled=true` and
    `effort=medium`
- Targeting: free users on the `ask-model-free` path only. The server also
  enforces eligibility, so paid users, Agent mode, non-Ask requests, other Ask
  model selections, and requests with files are excluded.
- Rollout: start with `reasoning_medium` at 10-20% of eligible traffic and keep
  the rest in `control`.

If the PostHog flag is not available yet, the server fallback env var
`FREE_ASK_REASONING_EXPERIMENT_TREATMENT_PERCENTAGE=10` can assign 10% of
eligible users to `reasoning_medium` and the rest to `control`.

## Events and properties

The experiment emits:

- `free_ask_reasoning_experiment_exposed`
- `free_ask_reasoning_experiment_result`
- `hackerai-usage_cost` with the same experiment properties

Filter or group by:

- `experiment_key = free_ask_deepseek_reasoning_v1`
- `variant` or `experiment_variant`
- `$feature/free_ask_deepseek_reasoning_v1`
- `reasoning_enabled`
- `reasoning_effort`

## Readout

Primary readout:

- Success rate: `free_ask_reasoning_experiment_result` where
  `outcome = success`, divided by `free_ask_reasoning_experiment_exposed`.
- Paid conversion: exposed users who later fire `checkout_started` or
  `subscription_started`, grouped by variant.

Guardrails:

- Cost: sum `cost_dollars` on `hackerai-usage_cost`, grouped by variant.
- Latency: average and p95 `generation_time_ms` on
  `free_ask_reasoning_experiment_result`, grouped by variant.
- Reliability: error/abort rate on `free_ask_reasoning_experiment_result`,
  grouped by variant.

Call `reasoning_medium` better only if it improves success or paid conversion
without materially increasing cost, latency, or error rate. If conversion is
flat and cost/latency are higher, keep free Ask on control.
