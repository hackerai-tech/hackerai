# Independent early paid-task feedback

Owner and release plan: [HAC-119](https://linear.app/hackerai/issue/HAC-119).
This cohort measures reported task resolution, subsequent use, and paid renewal.
Associations between answers and retention do not establish that the product
change caused retention or explain an individual's cancellation.

## Enrollment and interaction

`paid_task_outcome_feedback_v1` is a separate, stable user-level PostHog flag.
The server evaluates it for solo Pro, Pro Plus and Ultra requests in Ask and
Agent, whether or not a model experiment assigned that request. The Convex
reservation additionally requires the earliest recorded personal paid start to
be within the last seven elapsed days, an associated positive subscription
revenue entry, and no later recorded paid start. Team subscriptions, old or
missing payment evidence, and returning subscribers with another recorded start
are excluded. This is the first **observed eligible selection**, not proof of
first-ever payment or first-ever task; ledger history may be incomplete.

One independent invitation per user, with the existing cross-survey 72-hour
cooldown and 48-hour expiry. It is reserved before generation outcomes are
known. Failed/no-message runs stay selected even if no question can display.
The retired model-experiment survey no longer provides a fallback path.

The existing inline question offers **Solved my task**, **Helpful, still
working**, **Didn’t help**, and **Haven’t checked**. Answers save immediately;
helpful/negative answers may add a structured optional reason. Solved needs no
second click. Dismissal is not an answer. No prompts, findings, targets or free
text are captured.

`shown_at` is the atomic cross-device display claim. `viewed_at` separately
records the visible rendered question (at least 50% in view in a visible tab).
PostHog `_shown` is emitted at that same visibility boundary. Navigation between
claim and render can leave a claim without an observed view. Authenticated
`_answered`, `_reason`, `_dismissed` and server `_selected` retain the frozen
`survey_request_id`, `survey_kind: new_paid`, and baseline billing fields.
Independent invitations use `survey_version: 2` and UI version 4.

## Measurement and readout

Start with all durable `task_outcome_surveys` rows of kind `new_paid` in the
selection window. Left-join event delivery by `survey_request_id`; reconcile
PostHog selection, view and answer counts with Convex before drawing conclusions.
Use a fixed UTC cutoff after allowing ingestion to settle. Never inner-join on
answers, later activity, current subscription status or renewal survivors.

[The prepared HogQL readout](paid-task-outcome-readout.sql) computes the
analytics-observed cohort separately by billing interval. Set its cohort window,
activity bounds and fixed readout cutoff consistently; remove internal test IDs.
It is a prepared query, not a deployed dashboard or evidence of a live result.

- Report selected, viewed, answered, dismissed, not checked, still pending,
  expired without a view, and expired viewed-but-unanswered separately. Durable
  rows without `viewed_at` mean no **observed** view, not proof of no view.
- Primary task metric: solved / (solved + helpful + no). Also report solved /
  selected and response rate; not checked and nonresponse are unassessed.
  Include user counts, uncertainty intervals and missing-delivery rate. Do not
  compare this scale directly with the retired Yes/Partly/No survey.
- `chat_user_submission` version 1 records accepted manual composer submissions,
  including queuing. Rejected drafts, retries, auto-continuation and later queue
  dispatch do not emit this event. It measures user intent, not completion.
  D1 is [24h,48h) and D7 [168h,192h) after selection, unique users; only fully
  mature windows enter each denominator. Blocked client analytics remain an
  ascertainment limitation. This does not count app opens or background runs.
- Freeze the initial paid invoice's recurring line period end as
  `baseline_renewal_at` at selection. Old ledger rows without that field stay
  renewal-date-unknown; never replace it with today's subscription date. The
  webhook now persists immutable line periods and actual `invoice_paid_at`.
- Paid renewal requires a positive `invoice_paid` with `subscription_cycle`, the
  **same baseline subscription**, and a line period start equal to the frozen
  due date, paid by due + 7 days. Only mature due+7 windows enter the denominator.
  Keep pre-due cancellations in the denominator. Split monthly/annual/other
  intervals; no young annual subscriber counts as a nonrenewal.
- The prepared query measures gross observed paid renewal, not net retention.
  Separately inspect `attempt_count` / `recovery_result`, payment failures,
  refunds/disputes and period changes. Different-subscription replacements are
  not baseline renewals. A shifted billing anchor or missing webhook requires
  reconciliation; no observed invoice is not by itself proven churn.
  Report recovered payments separately and verify revenue-ledger coverage before
  a financial conclusion. Do not claim a causal experiment result.

## Activation and rollback

This PR does not create flags, activate surveys, or change runtime configuration.
Missing/off flags suppress new independent selection. Existing invitations can
remain for their 48-hour lifetime after flag disablement.

Before activation, verify Convex, Vercel and Trigger identities independently,
then deploy compatible schema/functions, web code and Agent worker. Preview
uses PostHog **401167**, planned 100% of its eligible test population. Production
uses **144137**, initially an explicit internal allowlist after authorization.
Do not infer either worker's project from Vercel alone or copy Preview's rollout.
Read back both flag definitions and targeting; record activation in HAC-119.

Owner Ross Manko; first review 2026-09-22, renewal review after cohort due+7
maturity. No automatic public ramp. Roll back on repeat prompts, attribution or
privacy defects, or disrupted chat. After the readout, explicitly retain or end
this measurement; disable both flags, drain invitations and remove its selection
path when ending. HAC-101 removed the model-experiment cohort; shared UI and
storage remain while this independent cohort still uses them.

## Preview acceptance

Use authorized disposable solo paid test accounts with real test-mode positive
paid-start evidence in the verified Preview environment. Enable the new flag for
those accounts independently of model assignment. Submit a bounded Ask request,
then use a fresh eligible account for Agent; verify completion, inline display,
view/answer persistence and original request linkage. Check mobile, keyboard,
helpful + optional reason, solved, not checked, dismissal, reload and another tab.
No second invitation within cooldown or after a user's one cohort invitation.

Repeat with flag off, free/team accounts, missing/old/zero payment evidence,
and a stopped or failed run. New cohort selection must fail closed without
blocking chat. Verify manual vs automatic submission events and replay a Stripe
test invoice with a changed current subscription date: the original invoice
period must remain the renewal baseline. Compare actual Vercel and Trigger
PostHog project identities. Live cohort/renewal measurement requires activation
and observation time; unit tests and fixture rendering cannot establish it.
