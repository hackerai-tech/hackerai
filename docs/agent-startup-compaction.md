# Agent startup compaction pilot

HAC-75 identified summary generation as the dominant startup tail. HAC-102
tests recovery from a slow or unavailable primary without changing summary
content, retained context, or transcript persistence.

## Behavior

The `agent_startup_compaction_v1` PostHog flag selects `bounded_glm_v1` only
for an explicit internal allowlist. Unrecognized, missing, or failed flag
evaluations use control. Ask requests, later Agent compactions, and requests
below the compaction threshold do not enter the pilot.

Treatment starts with the existing GLM 5.3 Flash low-reasoning summary model.
That attempt has a 30-second AI SDK timeout and no SDK retries. A timeout,
retryable upstream error, malformed JSON, or unusable summary triggers one
fallback to the existing DeepSeek V4 Flash 0731 route with low reasoning,
latency routing, and `data_collection: deny`. The fallback uses normal SDK
retry behavior and the original run cancellation signal. **30 seconds is a
primary-attempt deadline, not a total compaction deadline.** Preparation and
fallback time are additional.

The fallback gets the same source context. No output-token cap, smaller
context window, or new prompt is introduced. Empty or non-`stop` results
cannot replace stored context in treatment. If both attempts fail, the
existing compaction failure path preserves the original input; user
cancellation propagates without starting fallback.

## Evidence and limitations

Outside the pilot, the existing malformed-provider-JSON retry also uses low
reasoning on its Grok/Kimi fallback route. This applies to Ask and Agent
compaction: a response-format failure does not increase reasoning effort.

Run `pnpm exec tsx scripts/benchmark-startup-compaction.ts` with an existing
`OPENROUTER_API_KEY`. This makes four billable API calls using synthetic
fixtures only, with a four-minute maximum per call. Results are written to
the ignored `.artifacts/hac102/` directory. The benchmark checks exact state
markers and required section headers; this is not a general summary-quality
evaluation. Its direct API probes compare fallback feasibility and do not
measure the entire Agent pipeline.

The initial DeepSeek probes used approximately 15k and 69k input tokens and
finished in 19–20 seconds, preserving all 14 checked state markers and ten
headers. Manual inspection preserved scope, corrected credential label,
opaque IDs, and the unfinished process. The larger summary misstated the
number of repetitive completed probes by one. GLM baseline probes returned
upstream 429s, so these results do not establish a causal production speedup
or equivalent summary quality. Keep the initial rollout internal.

## Readout and rollback

Owner and review date live in [HAC-102](https://linear.app/hackerai/issue/HAC-102).
Actual startup attempts add `startup_compaction_variant` and
`startup_compaction_fallback_used` to the existing `hackerai-agent_run`
completion event. No exposure is emitted for mere flag assignment. Existing
startup summary and worker timers include the recovery; failed or abandoned
runs without a completion event are not represented in this event cohort.

Retain the startup timings for the [rolling regression readout](https://us.posthog.com/project/144137/insights/Pt8cDlVX)
and the tracked pilot review. These are in-memory counters attached to the
existing completion event, with no per-phase analytics events or user content.
Reassess retention when the review ends; remove unused fields if the readout
is retired.

Duplicate `agent_performance_diagnostic` warning logs retain all slow errors
and a deterministic 1% sample of slow successful or aborted runs, keyed by
Trigger run ID (chat ID when unavailable). `log_sample_rate` records the
selection rate. Use the unsampled completion events for percentiles and outcome
rates; sampled warnings are for individual trace investigation.

Compare timing p50/p95/p99, successful continuation, abort/error rates,
fallback frequency, and compaction usage cost against control. Include
summary completeness and retained-context checks. Provider usage from an
aborted call may be unavailable; do not claim its cost is zero. Do not ramp
based on synthetic timing alone. Disabling the flag restores control without
a deployment. Remove the flag only after the tracked production readout and
reassess whether its telemetry remains useful.

## Manual verification

1. In an internal pilot account, resume a long Agent chat that needs initial
   compaction. Confirm the summary preserves scope, recent corrections,
   active process/session IDs, and the retained tail, then continues work.
2. In a test provider harness, delay the primary beyond 30 seconds or return 429. Confirm it aborts or fails once, and a complete fallback summary is
   persisted with the correct model and fallback telemetry.
3. Cancel during primary or fallback generation. Confirm prompt termination,
   no subsequent provider call, and no incomplete summary persisted.
4. Disable the flag and repeat. Confirm ordinary GLM behavior; Ask and later
   in-run compactions should remain outside the pilot.
