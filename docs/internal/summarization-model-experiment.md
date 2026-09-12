# Summarization model experiment

[HAC-108](https://linear.app/hackerai/issue/HAC-108) owns the hypothesis,
rollout decisions, owner, review date, and cleanup plan. This experiment is
independent of the compaction feedback change in HAC-107.

## Treatment and assignment

`summarization-deepseek-v41-v1` assigns authenticated users consistently to
`control` (`z-ai/glm-5.3-flash`) or `test`
(`deepseek/deepseek-v4.1-flash`). Missing, disabled, invalid, or unavailable flags
retain the existing GLM route. The flag is evaluated only when context actually
needs summarizing. Ask and Agent share the selection for durable and in-run
compaction. Prompts, retained history, summary validation, and authorization
remain the same. Both arms request low reasoning and latency-first routing
with provider data collection denied.

The separate `agent_startup_compaction_v1` pilot still controls the startup
30-second primary deadline and fallback. Its existing DeepSeek V4 Flash 0731
fallback is unchanged. Analyze startup policy separately: otherwise the new
model effect can be confused with the deadline/fallback policy.

## Measurement contract

Assignment is not exposure. Generation emits
`summarization_model_experiment_exposed` and an explicit `$feature_flag_called`
with the assigned variant after cancellation checks. PostHog duplicates flag
exposures into `$experiment_exposure` on ingestion for its new exposure system;
read each experiment's `resolved_exposure_event` before validating ingestion.
Do not emit another `$experiment_exposure` manually.

`summarization_model_experiment_finished` records generation duration (including
fallback), success/error/aborted outcome, configured and final served models,
fallback use, mode, scope, startup policy, and a per-attempt ID. Join by that ID
to find missing outcomes. No prompts, targets, findings, generated summaries, or
error text are captured. Success here means valid summary generation, not
successful persistence or completion of the following task.

Use generation duration as a per-compaction ratio (sum of `duration_ms` divided
by completed outcome event count), alongside p50/p95 diagnostic queries. Do not
use total latency per user as if it were latency per compaction. Compare failure,
abandonment, fallback, retained-context correctness, and subsequent continuation
separately. `final_call_cost_usd` covers only the successful final call; failed
and cancelled provider costs can be missing. Do not treat missing cost as zero
or present that field as full attempt cost. Cross-check provider billing before
making a cost decision.

## Environment and launch checks

Preview uses PostHog project **401167**, experiment **463511**, flag **881105**;
Production uses project **144137**, experiment **463510**, flag **881102**. Each
has independent state. Preview enrolls 100% of eligible QA users with a 50/50
variant split. Production starts disabled with only the existing internal
allowlist prepared, also split 50/50. Enrollment and variant allocation are
different percentages. Current rollout state belongs in Linear/PostHog.

Before launch, independently verify the Vercel and Trigger worker PostHog
project keys against the intended project, plus their designated Convex target.
A Vercel Preview deployment does not prove its Trigger worker uses Preview
configuration. Deploy code, start a new Agent run, exercise both variants and
Ask/Agent compaction, and verify exposure plus outcome ingestion. Existing Agent
runs can remain pinned to an earlier worker version.

The internal pilot provides functional and directional evidence, not a powered
population experiment. Review context retention and continuation before any
public ramp, then choose sample size from observed variance. Keep Production
disabled if benchmark or acceptance evidence shows a material regression.
Rollback by disabling the flag in the affected project; subsequent compaction
lookups return to GLM without a redeploy. In-flight calls finish their selected
model. Remove the flag and branch only after the recorded readout decision.
