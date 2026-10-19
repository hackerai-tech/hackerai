# Paid Pro/Auto response-model experiment

Decision, owner, review criteria, rollback thresholds and cleanup plan:
[HAC-181](https://linear.app/hackerai/issue/HAC-181).

The owner closed Production experiment 492909 and Preview QA experiment 492910
on October 19, 2026, requesting full paid Pro/Auto rollout before the planned
review. This is an early shipping decision, not a conclusive response-quality win.
Historical experiment results and the request-joined SQL readout remain available.

Authenticated paid Pro/Auto requests in Ask and Agent now resolve to the exact
`deepseek/deepseek-v4.1-flash-1017` snapshot with high reasoning after existing
moderation and rescue gates. Native image inputs and later image tool results
keep that snapshot. Explicit Standard/Max, Free, allowance rescue, moderated
model policy, subagent defaults and compaction models remain outside this route.
The separate Free Agent 1017 experiment remains flag-controlled.

`paid_pro_auto_deepseek_1017_v1` remains active independently in Preview PostHog
401167 and Production 144137, with 100% eligible enrollment and control 0% / test
100%, targeting pro/pro-plus/ultra/team. This preserves treatment on older
Vercel/Trigger deployments until cleanup is deployed. The shipped resolver no
longer evaluates this flag or emits new paid experiment assignments, exposures
or experiment-specific outcomes; ordinary usage and completion analytics remain.
A new request picks up the remote rollout without a deployment; an in-flight
request keeps its assignment. Deploy the cleanup to both Vercel and Trigger to
remove the runtime flag dependency. Archive the flags only after both runtimes
have deployed the cleanup and older in-flight runs have drained. After cleanup,
rollback requires reverting the routing change and deploying both runtimes;
disabling the retired flag no longer changes the shipped code.

## Historical measurement contract

Assignment does not emit exposure. `flash_routing_experiment_exposed` fires once
at the matching provider request, using the original assistant ID as
`experiment_request_id`. `paid_model_response_outcome` reports Ask and Agent
terminal outcomes, empty responses, natural completion, latency, served model,
recovery and tool failures, while retaining the assignment through fallback.
Its `message_id` points at the displayed retry message when recovery changes the
ID. Join existing `message_feedback_submitted` events on user ID and that message
ID. Use the latest feedback per message, retaining both feedback coverage and
missing feedback. No new survey or customer content collection is introduced.

`hackerai-usage_cost` retains the same experiment request ID and includes actual
provider-reported cost where available, with separately identified model,
non-model, sandbox and Trigger costs. Snapshot aliases have explicit peak-rate
estimates when provider cost is unavailable. Do not substitute default model
pricing or omit failed/discarded attempts. Check `cost_source` and
`usage_discarded_retry_cost_dollars`. Compaction cost remains part of total
request economics, although its model policy is unchanged.

Duration and first-chunk latency start after flag evaluation, before preflight
and sandbox setup. The first chunk can be reasoning; it is not visible-answer
latency. Use `chat_visible_response_performance` separately for perceived speed.
Agent run events also retain provider-recovery and active-runtime timing. Do not
interpret output tokens divided by full request duration as provider throughput;
Agent duration includes tool and approval waits.

The PostHog experiment uses request-rate ratios for completion and cost per
completion. Its negative-thumbs funnel is a user-level diagnostic that can
include feedback on other messages. The request-joined SQL readout is the
response-specific comparison in `paid-deepseek-1017-readout.sql` (freeze its UTC bounds and validate after the new events are ingested). Keep missing terminal/cost events visible, and
segment Ask/Agent, selector, tier, baseline and sandbox transport. Exclude
internal test identities using the project's test-account filters when running
Production analysis; Preview QA is not evidence of user benefit. Check sample
ratio mismatch on unique users, repeat-user clustering and feedback response
bias before deciding. A natural completed answer is a technical outcome, not
proof that the user's task was solved.

## Verification of the shipped route

On the actual Preview URL, use the repository's configured paid test account.
Verify Auto and Pro in Ask and a bounded Agent request, including a harmless
tool call, native image input/tool result, reload persistence, cancellation and
bounded fallback. Confirm exact requested/served snapshot and high reasoning,
no paid experiment exposure or assignment, and ordinary requested/served model,
completion and cost telemetry. Submit thumbs feedback and confirm the
user/message join. Verify Free, Standard/Max, allowance rescue and moderated
routes retain their existing policy. Exercise both cloud and local/desktop transports when
available; an unavailable transport remains a listed manual verification item.
Read back both flags and runtime PostHog identities separately. No Convex schema
or credential changes are required.
