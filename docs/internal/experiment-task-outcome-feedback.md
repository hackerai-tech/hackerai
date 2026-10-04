# Current experiment task feedback

HAC-120 adds a secondary task-outcome measure to HAC-142. It does not change
model allocation, eligibility, primary completion metrics, or retention rules.
`abliterated_task_outcome_feedback_v1` controls delivery independently from
model routing. Use authenticated user bucketing and the same
feedback percentage for control and test. Preview uses 100% feedback; the initial
Production feedback sample is 10%. Record activation timestamps, runtime release
identities, owner, rollback, readout cutoffs and removal decision in HAC-120.

The immutable cohort is `current_experiment`, version 3. Keep these key/phase
pairs separate in reservations and readouts:

| Assignment key                          | Feedback phase                                   | Eligible selector/source                                                    |
| --------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------- |
| `abliterated_max_moderated_v1`          | `abliterated_max_moderated_feedback_v1`          | Historical Pro/Max moderation assignments                                   |
| `abliterated_paid_first_step_v2`        | `abliterated_paid_first_step_feedback_v2`        | All paid selectors, `paid_first_step`, control and test                     |
| `abliterated_paid_moderated_default_v1` | `abliterated_paid_moderated_default_feedback_v1` | All paid selectors, `moderation`, shipped default (`test` attribution only) |

An omitted selector is recorded as `auto`. The shipped default is descriptive
feedback, not another experimental treatment arm. A new routing key must add an
explicit feedback phase decision; the exhaustive mapping is checked by TypeScript.
Both old and new keys remain accepted during Vercel/Trigger deployment skew.
The Convex validators must deploy before a worker uses a new reservation shape;
selection failures emit bounded stage/request diagnostics without interrupting chat.

Only actual server assignments can enter. Team participation is per authorized
member; no shared payer or first-payment inference is made. The original
assistant-message ID joins `survey_request_id` to `experiment_request_id`.
Recovery changes only the visible message ID. Selection occurs before generation
outcomes and model-priced checks; failed, stopped, budget-blocked and missing-output
requests retain their selected records. Historical cohorts keep their data.

One invitation per user per experiment phase, a shared 72-hour cooldown, and
48-hour expiry apply. Convex `shown_at` means a surface claimed the invitation;
`viewed_at` means the rendered question was actually visible. The existing
PostHog `task_outcome_survey_shown` event means actual question visibility, not
the claim. Answer, dismissal, not-checked and silence remain distinct. No free
text or task content is captured. Disable only the feedback flag for rollback
of new invitations; existing reservations retain their original 48-hour lifecycle.

## Acceptance

Verify the designated Preview account/deployment and Vercel/Trigger targets
independently. Use a disposable authorized request with each applicable selector
in Ask and Agent. Confirm the normal routing gate produces a real assignment,
the neutral question renders, and an answer persists. Reload and verify suppression;
check mobile wrapping and keyboard access. Reconcile original request IDs, phase,
variant and selection/view/answer timestamps between Convex and PostHog. A
Preview treatment-only allocation cannot prove live control behavior; retain
allocation and report that limitation rather than changing the model flag.
Check Free/nonparticipant exclusions, stop/missing output, and recovery linkage.

## Secondary readout

Run `experiment-task-outcome-readout.sql` separately in PostHog 401167 and 144137
with frozen activation, cohort-end and as-of bounds. The analytics-observed
cohort is a diagnostic, not the source of truth: compare it with bounded Convex
`task_outcome_surveys` reads for this exact phase. Join on original request IDs,
not replacement message IDs. Filter phase on the selected cohort, then join activity
on authenticated user and immutable request ID: older clients can omit phase
metadata on an otherwise valid view. Aggregate each invitation once so duplicate
view delivery cannot inflate the denominator. Missing selection/view/answer telemetry is a delivery
gap; never count it as a task failure. Export only identifier and allowlisted
survey/outcome fields for reconciliation. Exclude recorded internal/test accounts.

Report selected, claimed, viewed, answered, dismissed, pending and expired counts.
Response rate is all four answers / selected, with answered / viewed separately.
Solved fraction is solved / (solved + helpful + no); show helpful separately.
Also report solved / selected, not-checked and all delivery/unknown categories.
Break down each phase separately by arm, Ask/Agent and selector, preserving the subscription tier.
There is one invitation per user in this phase, so request-level rates within each
cell also have one independent observation per user. For between-arm estimates,
bootstrap authenticated users, keeping all of each user's records together;
report intervals and sample sizes, and suppress efficacy claims for sparse cells.
Nonresponse and differential response are selection bias, not missing-at-random
evidence. The primary completion denominator and baseline-renewal/cancellation
protocol stay in HAC-142. Never call feedback silence failure or retention.
