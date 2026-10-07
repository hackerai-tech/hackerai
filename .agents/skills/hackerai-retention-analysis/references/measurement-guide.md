# Measuring whether a change increases subscriber churn

Use this guide when evaluating model routing, allowances, pricing, onboarding,
or another change that could affect paid retention. The goal is to distinguish
an early experience warning from a supported increase in subscriber losses.
Keep dated results in the owning Linear issue or a task artifact, not here.

## Before a rollout

Follow the experiment-planning requirements in [AGENTS.md](../../../../AGENTS.md). In the owning issue,
define the eligible population, assignment unit, primary outcome, minimum
business-relevant effect, sample-size rationale, guardrails, rollback rule,
owner, readout dates, and cleanup plan.

Prefer stable randomized assignment by user, or by payer/subscription when
multiple users share billing. Keep a control group through the intended outcome
window when safe. A retention comparison usually needs the next billing cycle
and a predefined recovery window; annual plans need separate handling. Safety
or correctness rollbacks take precedence over waiting for a clean experiment.
Record every allocation or routing change and preserve original assignment.
Do not reopen a model or rollout the owner has explicitly rejected.

Distinguish assignment, actual provider/feature exposure, and successful output.
Use request/run identifiers to link exposure to outcomes. Preserve configured
model, served model/provider, fallbacks, and missing-response outcomes. Do not
form cohorts only from successful requests or classify users by a future model.
If enrollment begins at actual exposure, call the result exposure-anchored;
do not present it as ITT over everyone originally assigned.

## Evidence needed

Verify actual schema and coverage before querying. The following is a required
analytical contract, not a claim that every field already exists:

| Evidence         | Required meaning                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Identity         | Stable analytics user, payer, subscription, invoice, and request/run joins; deduplicate shared billing without treating seats as customers                   |
| Enrollment       | Assignment and first actual exposure times; plan, billing interval, observed tenure, prior activity/failures, and relevant client/mode at or before exposure |
| Renewal schedule | Next scheduled renewal and paid period known at enrollment, including schedule changes; preserve history rather than substituting today's period end         |
| Cancellation     | Decision time and effective ending time separately; source, reversal, pause, and reason classification                                                       |
| Payment          | Invoice first failure, attempt sequence, actual paid time, subscription state at payment, refund/credit, and verified access recovery                        |
| Provenance       | Source event ID, business occurrence time, ingestion time, event version, and coverage start/breaks                                                          |

Inspect billing source identity, availability, and freshness read-only before
proposing a repair. Catalog presence alone does not prove a table is queryable
or current. An inaccessible or empty source is not permission to reconnect,
seed, or copy credentials. Follow the repository's environment boundaries.
Use [payment recovery verification](../../../../docs/payment-method-recovery.md) for the
card-update, payment, and restored-access journey.

Keep analytics content-free. Never add prompts, targets, findings, payloads,
code, card details, or customer conversation content. Any content-based
research requires the separate authorized HackerAI research workflow.

## Outcome definitions

| Outcome                              | Denominator and window                                                                                                                                                                                           |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Natural Agent completion             | All eligible exposed requests, including errors, aborts, and missing outcomes; success + stop + no step-limit is an operational proxy, not verified task quality                                                 |
| Return usage                         | Users with the same complete follow-up after exposure; define exact elapsed-hour intervals, deduplicate requests, and distinguish user return from retries/automatic continuations                               |
| New voluntary cancellation decisions | Enrolled subscribers without a pending decision at baseline; decisions within a fixed window, with pauses and reversals reported separately                                                                      |
| Renewal retention                    | All eligible subscriptions enrolled at baseline, retaining pre-renewal cancellations; assess outcomes after the baseline scheduled renewal date plus required follow-up. Do not require an invoice for inclusion |
| Payment success among attempts       | Distinct eligible renewal invoices actually attempted; label this conditional rate, not subscriber renewal retention                                                                                             |
| Payment recovery                     | Distinct invoices entering first failure, each with equal fixed follow-up; payment on the same invoice/subscription is required, and restored access is a separate outcome                                       |

State exactly how pauses, trials, free/zero-dollar invoices, refunds, plan changes,
annual billing, and admin/fraud endings affect eligibility and outcomes. Treat
reactivations and replacement subscriptions separately from renewals or recovery
of the old subscription. A cancellation decision is not its later ending, and
a card update is not payment or retention.

Freeze enrollment and the baseline schedule so treatment-induced cancellation
cannot silently remove a subscriber from the renewal denominator. Count
subscriptions that end before renewal as non-renewals; a pending cancellation
that is reversed before successful renewal is not a renewal loss. When only
paid/failed invoice events exist, report an observed-attempt proxy and disclose
that the full subscriber renewal rate is unavailable.

## Analysis and interpretation

Use original randomized assignment for the primary comparison. Report actual
served-model overlap, provider changes, and allocation changes as fidelity
checks; do not relabel controls after fallback or exclude crossover based on
future behavior. A short trial followed by shared routing estimates brief
exposure, not sustained exclusive use of a model.

Without valid randomization, use comparable calendar periods and pre-exposure
plan, billing interval, tenure, activity, renewal schedule, failure history,
and relevant mode/transport. Report missing covariates and overlap. Never match
on future usage, successful completion, recovery, or churn. Call observational
results associations. Conditioning on a post-assignment payment failure also
makes a recovery comparison conditional, not an unconditional randomized effect.

Account for repeated runs per user and shared subscriptions in uncertainty.
Report both request totals and user-weighted outcomes where heavy users can
dominate. Use confidence intervals appropriate to small samples; non-significance
does not establish equivalence. Predeclare meaningful effects and guardrails,
and disclose multiple comparisons or early stopping.

Payment-failed endings identify the billing mechanism, not customer motivation.
Dissatisfaction may reduce willingness to recover. Do not rule out a product
contribution because the first failure preceded the change or because most
endings were classified as payment failures.

## What to tell the owner

Every readout should include:

1. A clear status: early warning, mature observed increase/decrease, inconclusive,
   or not measurable with current coverage. A causal claim additionally requires
   a defensible design and attribution.
2. Exact population, dates, timezone, follow-up, and unit. Show numerator and
   denominator in both groups, rates, absolute percentage-point difference,
   and uncertainty. Translate a supported difference into additional losses per
   100 eligible subscribers; do not extrapolate a conditional invoice rate.
3. Voluntary decisions, voluntary endings, payment failures, recovery, pauses,
   and reactivations separately, plus task/return-use guardrails.
4. Missing evidence, crossover, immature outcomes, and the earliest valid next
   readout. Elapsed time alone does not guarantee sufficient sample size.
5. A concrete recommendation and reproducible queries/aggregate artifacts.

Use this wording pattern, filling only verified values:

> Among [eligible subscriptions] reaching [baseline renewal window], [x/n]
> were lost in treatment versus [x/n] in control: [difference] percentage
> points, with [uncertainty]. The main observed mechanism was [mechanism].
> This [supports / does not establish] an effect of the change because [reason].

For an immature result:

> [Completion / return usage / cancellation decisions] worsened. This is an
> early warning; the renewal comparison is not mature. The next valid readout
> requires [date/window] and [missing evidence].

Do not schedule a monitor or promise future notifications merely because a
readout date is documented. Scheduling requires a user request and a configured
automation. A report, a working recovery path, and an automated monitor are
separate deliverables.
