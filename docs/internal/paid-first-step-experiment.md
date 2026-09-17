# Paid first-step model experiment

[HAC-122](https://linear.app/hackerai/issue/HAC-122) owns the hypothesis, rollout,
guardrails, owner, review dates and removal plan.
[Production experiment](https://us.posthog.com/project/144137/experiments/464899).
[Readout dashboard](https://us.posthog.com/project/144137/dashboard/2105165).

The experiment expands base Abliteration to otherwise eligible solo paid first
steps with a low moderation score. Existing moderated/history-selected base and
Large v2 routes remain in both arms. Later generation steps retain the original
baseline, including when a control user already qualifies for Abliteration.
Moderation still runs: failed checks, upper-score/category safety gates, rescue,
unsupported files, missing credentials and non-solo plans do not become eligible.
Automatic continuation requests also retain existing routing without new enrollment.

The authenticated user is the assignment unit. Initial enrollment verifies an
active single-seat subscription and freezes its next renewal, billing interval,
subscription/customer/organization IDs, tenure and pending cancellation. Team,
trial, paused, ambiguous and past-due enrollments are excluded. Billing lookup
has a two-second total budget and fails back to existing routing. Concurrent
enrollment is first-writer-wins; later flag changes cannot overwrite assignment.
The live flag is checked before enrollment on every request, so disabling it
returns new requests to current routing. Account deletion removes enrollment.
For Agent, the authenticated web route prepares the billing snapshot before
dispatch; the Trigger worker only reads it, so billing credentials stay in the
web runtime. Preparation does not establish analytics exposure: the worker's
safety/eligibility checks must still pass before emitting the eligibility event.

## Measurement

`abliterated_model_eligible` anchors the analysis before model output. This is
eligible-request enrollment, not ITT over every paid account or a cohort of only
successful calls. `abliterated_model_exposed` records first actual text/tool
output. `experiment_request_id` links eligible, exposed, provider and final
outcome events through retries. Generic usage events receive the same frozen
experiment context. No prompts, targets, generated text or billing secrets are
captured. Full provider/model history remains in the final request log.

Primary: natural completion (success, content, stop, no step-limit reached) per
eligible request. Include missing outcomes, errors and aborts in the denominator;
report user-weighted and request-weighted results separately. This is an
operational proxy. Existing task-outcome surveys retain experiment attribution
in both arms and their cross-device 72-hour cooldown. Report selection, shown,
answered, dismissal and success rates separately; respondent success alone is
not overall task success. New-paid survey answers and legacy answers have
different semantics and must be segmented by survey kind.

The experiment UI includes completion, errors, task-success reports, user return
in days 1–7, cancellation decisions and effective endings. Billing funnels are
early indicators, not mature churn estimates. Do not interpret immature users as
failures. For fixed follow-up, return means a distinct `chat_user_submission`
between 24 and 168 elapsed hours after first eligibility; automatic continuation
does not emit this event. Segment Ask/Agent, baseline plan, billing interval,
existing route and new expansion; never segment by a treatment-caused outcome.

[Operations SQL](../analytics/paid-first-step-operations.sql) deduplicates request
IDs and reports missing outcomes, completion, errors, aborts, fallbacks, recovery,
cost and usage coverage. Its latency column is explicitly the mean of users'
p95s; use provider outcome `first_content_ms` and exposed `time_to_exposure_ms`
distributions for the experiment's pooled p95 guardrail. These are model-stream
timings, not end-to-end startup latency; Agent also reports request-to-first-chunk.

`provider_priced_cost_dollars` estimates all reported calls, including retries and
continuations. It uses [published Abliteration rates](https://docs.abliteration.ai/pricing)
verified September 16, 2026, and configured rates for other models. Customer
allowance accounting is unchanged. Missing usage is not zero spend: inspect
usage coverage and reconcile provider invoices. Compare normalized costs and
incremental cost per extra completion; do not compare raw 90/10 arm totals.

[Renewal SQL](../analytics/paid-first-step-renewals.sql) anchors each subscription
on its original renewal date and waits seven days for recovery. Pre-renewal
cancellations remain in the denominator. Existing pending cancellations and
annual/multi-month subscriptions are separate strata. A positive cycle invoice
on the same subscription near its original due date confirms observed renewal;
replacement subscriptions and plan changes require separate reconciliation.
Unobserved payments are labeled unresolved, not confirmed churn. Verify Stripe
webhook freshness and coverage, refunds/credits, zero-dollar renewals, pauses,
schedule changes and account-deletion attrition before a final retention claim.
Report voluntary decisions, reversals, pauses, effective endings, first payment
failures and same-invoice recovery separately. Freeze the original denominator;
never require an attempted invoice for inclusion.

The SQL files are saved as prelaunch definitions on the readout dashboard.
Validate them against Preview events and source schema before launch. Require
coverage and a mature, powered readout before ramping. The native experiment
uses its default crossover handling; the cohort SQL preserves first assignment
and reports crossover separately. Immutable enrollment should prevent crossover;
any nonzero count needs investigation before trusting native experiment results.

## Deployment and acceptance

Deploy Convex schema/functions, Vercel and Trigger workers. This is not a
flag-only release. Follow the environment mapping and independent verification
in [the deployment runbook](free-monthly-budget-experiment.md#deployment-and-rollback).
Do not infer a Trigger PostHog key from Vercel configuration.

The flag key is `abliterated_paid_first_step_v1`. Preview project 401167 uses
flag 892023, active with 100% forced treatment for solo paid plans. Production
project 144137 uses flag 892019, inactive while the experiment is draft, with
100% enrollment and 90% control/10% treatment saved. Application eligibility
gates apply in both environments. Live state and acceptance evidence belong in
HAC-122 rather than being inferred from this document.

On verified Preview, use a disposable paid Ask and Agent chat with a bounded
request requiring one tool. Verify base Abliteration first, baseline afterward,
final provider history, frozen enrollment and linked eligible/exposed/outcome
events. Reload and send again: assignment and renewal baseline must remain.
Verify a preexisting Large v2 route, baseline control with a test fixture, a
provider failure/retry, cancellation and disabled-flag rollback. Verify the
feedback prompt and answer attribution. Confirm Production remains inactive.

Launch only after those checks and billing-source reconciliation pass. Preserve
original assignments through the renewal window; do not ramp by changing this
experiment's variant split. Disable the flag immediately for a safety/routing
regression; use HAC-122's cost, reliability and latency thresholds for rollback.
After the reviewed decision, remove or graduate the flag and retire the temporary
enrollment table through a separately reviewed cleanup that preserves the readout.
