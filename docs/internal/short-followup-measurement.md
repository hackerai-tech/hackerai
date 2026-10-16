# Short follow-up measurement

`abliterated_short_followup_v1` enrolls explicit `control` and `test` variants
only after the existing paid, owned-chat, independent-history and current
moderation gates pass. Control keeps the selected baseline; treatment uses
Abliteration for one generation step. Boolean/off/missing/error flag values
are not enrolled controls. Stable authenticated user bucketing is shared across
Ask and Agent. Do not change the variant split after launch.

## Release gate

HAC-174 is blocked by HAC-170 (`moderation_compaction_recovery_v2`). Keep
Production inactive at 0% until its owner records the compaction keep/revert
decision and stable final policy, and approves the new pilot. An inactive
compaction flag alone does not establish completion. The rollout record belongs
in Linear, including owner, activation/release, readout date and cleanup.
Preview enrolls 100% of eligible users with equal control/test variants;
Production starts only at the subsequently approved enrollment percentage.
No automatic ramp or scheduled activation.

## Measurements

- `abliterated_model_eligible` is pre-generation enrollment in both arms.
  `followup_measurement_version=1` excludes earlier boolean-flag QA. It is not
  actual exposure. `abliterated_model_exposed` records the first delivered
  provider text/tool content, including fallback providers.
- `experiment_request_id` stays the original assistant ID across recovery.
  `abliterated_model_message_linked` maps replacement `message_id` values to it.
  Join `message_feedback_submitted` by authenticated user and message ID through
  that mapping; use the latest feedback per message, not counts of toggles.
- `abliterated_model_response_outcome` provides final state, provider attempt
  totals, failures, empty/truncated output, fallback, duration and usage coverage.
  Never infer helpfulness or refusal from nonempty completion alone.
- `hackerai-usage_cost` gives the cumulative accounted request cost, including
  request overhead. Provider telemetry isolates generation cost including
  retries. These are different views of the same spend: never add them together.
  Unknown usage/cost is not zero; report coverage and missing final events.
- Dedicated `abliterated_short_followup_feedback_v1` surveys reuse neutral task
  feedback. Both arms use the same independent delivery flag, one invitation
  per user/phase, shared 72-hour cooldown and 48-hour expiry. The rollout must
  record the delivery percentage alongside enrollment; feedback sampling can
  make a small pilot too sparse to establish quality.

Primary quality readout: `(solved + helpful) / (solved + helpful + no)`, with
numerators and denominators. Show `not_checked`, invitation/view/answer rates,
pending/expired/dismissed and solved/helpful per selected separately. Compare
refusal, incorrect, incomplete and missed-request reasons; reasons are optional
and later updates must not inflate answer counts. Silence is unknown. Different
response rates can bias quality estimates even with identical sampling.

## Readout and decision

Run `short-followup-readout.sql` with frozen activation, cohort end and as-of
UTC bounds and recorded internal/test exclusions. Keep first-user assignment,
failed/aborted requests, crossovers and missing outcomes. Missing after one hour
is a diagnostic, not proof a long Agent run failed. Report estimates with
user-clustered uncertainty, not request counts treated as independent users.
Use the task-feedback SQL with the exact key/phase above and reconcile survey
selection/delivery against bounded Convex records. The live dashboards are
operational diagnostics; use frozen cohorts for the keep/revert decision.

Review quality beside accounted cost per enrolled request, p95 cost/latency,
error/empty/fallback rates, provider usage coverage and cache/context mix.
A one-step limit is not a dollar cap. Pause for confirmed broken continuation,
moderation-gate regressions or broken measurement. Set the economic threshold
and minimum worthwhile quality effect in the owner-approved rollout record;
do not expand on nonempty completions alone.

Seven-day return and cancellation decisions are secondary: use equal mature
follow-up from first enrollment. Renewal needs authoritative baseline billing
eligibility, including users who cancel before an invoice is produced. Do not
use current payer status or survey respondents as the retention denominator.
Team seats need payer-level billing analysis. Do not claim retention uplift
from this request dashboard or from the motivating canceled customer's case.

No prompts, targets, findings, code, payloads or new classifier calls enter
these measurements. Feedback failure must never interrupt a response.
