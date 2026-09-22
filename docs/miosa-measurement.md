# Miosa versus E2B measurement contract

Rollout ownership, current percentages, dashboard links and readout decisions
belong in [HAC-78](https://linear.app/hackerai/issue/HAC-78/rollout-miosa-as-primary-cloud-agent-sandbox-with-e2b-fallback).
The [pilot runbook](miosa-pro-pilot.md) defines eligibility and rollback.

## Cohorts and denominators

Keep Production and Preview in separate PostHog projects. Separate internal
acceptance accounts from customer results. Use stable user assignment and
`trigger_run_id` to correlate parent Agent events; do not join by chat alone
because a chat can have many runs. Deduplicate retries before calculating rates.

`miosa_cloud_sandbox_rollout_exposed.variant` is the assigned arm, not the final
provider. A Miosa attempt rescued by E2B still belongs to the Miosa arm.
`miosa_cloud_sandbox_enrollment_denied` is an eligibility veto, not a Miosa
outage or exposure. Show these separately by reason. Neither flag evaluation
nor a successful model response proves that a sandbox was used.

For customer comparisons, restrict to Pro and Pro+ parent Cloud Agent runs with
actual rollout exposure. Split acquisition results by boot path, region and
model; never compare all legacy E2B workspaces against only fresh Miosa workspaces.
`reuse_existing` currently combines warm reuse and paused restore, so it is
not a pure resume benchmark. Confirm pause duration and restore mode through
disposable acceptance tests before making resume-performance claims.

The pilot is operational monitoring, not yet a balanced randomized experiment:
the fresh-workspace gate is applied to Miosa candidates. A completion or cost
comparison remains observational unless equivalent enrollment eligibility and
follow-up cohorts are established for the E2B control. Do not change the boolean
routing flag into multivariate values: runtime routing requires boolean `true`.

## Scorecard

| Metric                  | Definition / caveat                                                                                                                                                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Completion              | Successful parent Agent runs / exposed runs; show error, abort and missing terminal outcome separately. A missing outcome may be in flight or lost telemetry, not success.                                                                                                                                   |
| Acquisition reliability | Successful `cloud_sandbox_acquisition_completed` / all completed acquisition attempts; deduplicate and aggregate by run for run-level rates. Report enrollment vetoes separately.                                                                                                                            |
| Fallback                | Runs with `cloud_sandbox_provider_fallback` / Miosa-exposed runs. Show final provider and whether the rescued run completed. Never use model `fallback_served` for sandbox fallback.                                                                                                                         |
| Startup / reconnect     | Acquisition p50/p95 by arm and boot path, plus request-to-first-model-chunk p50/p95. The acquisition completion event measures the full wait across Miosa and E2B, not just the successful provider.                                                                                                         |
| Tool / recovery health  | Active terminal and recovery duration, handled tool failure count, and tool count per run. Handled failures include non-sandbox tools; do not label all of them sandbox failures.                                                                                                                            |
| Persistence             | `terminal_output_persistence_failure`, including recovered versus failed outcomes, correlated by run. This measures output-saving failures, not all filesystem durability. Periodic hash-based pause/restore and deletion/isolation acceptance remain required.                                              |
| Cost / margin           | Correlate `hackerai-usage_cost.trigger_run_id` with assignment and completion. Include both providers, model and worker costs for failed/fallback runs; divide total observed costs by completed runs. Show cost-event and sandbox-cost coverage. Missing/zero provider cost is not proof of free operation. |
| Coverage                | Counts, distinct users, run IDs, missing outcome/boot/cost fields, latest event timestamp and sample size. Old events cannot backfill new fields.                                                                                                                                                            |

`hackerai-tool_usage` remains one aggregate event per request. Cost and tool
events now carry the durable Agent ID; Ask retains its existing behavior.
Acquisition completion contains only bounded routing/lifecycle metadata, never
commands, output, filenames, prompts, targets, credentials or provider bodies.

## Decisions

Sandbox accounting version 2 uses request-scoped elapsed runtime at each
provider's configured compute rate, for both Ask and parent Agent requests.
Miosa's cumulative `estimated_cost_cents` is not a billing input.
The Miosa shape and verified rate live together in `miosa-cost.ts`; review the
rate against tenant `computePricing()` when the provider changes pricing.
The normal usage multiplier and incremental deduction logic still apply.

This is allocated request compute, not invoice reconciliation. Timing starts
when a usable sandbox is acquired; pre-acquisition failures, idle time between
requests, and provider maintenance are platform overhead. Independent concurrent
parent requests each accrue runtime, matching E2B; child agents do not charge
shared runtime again. Do not describe summed request costs as the exact vendor
invoice or mix version 1 and version 2 measurements without labeling them.

Production suppresses successful acquisition-step console logs unless
`MIOSA_DEBUG_LOGS=true`. Failures remain warnings and PostHog retains the step
events and the single acquisition-completion summary.

Review completion first, then acquisition/fallback, latency, persistence and
economics. Include sample counts with percentiles; a handful of internal tests
cannot establish customer reliability, retention or cost superiority. Measure
repeat Agent usage and cancellation/feedback only after a meaningful customer
cohort has accumulated; keep these user-level outcomes separate from run-level
success. Do not expand on empty charts or credits subsidizing testing.

Stop expansion immediately for confirmed data loss, isolation/deletion defects
or broken output/cancellation. Apply the existing pilot review window and
guardrails; dashboard construction does not authorize a rollout increase.
