# Task outcome feedback (HAC-99)

Measures user-reported task success for the **whole three-step routing policy**,
including its baseline continuation and recovery. It cannot isolate the quality
of an individual Abliteration call. Existing provider assignment is unchanged.

## Quiet interaction

- Select before model-priced budget checks or generation, for both experiment
  variants. At most one opportunity per authenticated user per rolling seven days,
  atomically reserved in Convex across concurrent runs/devices.
- Only the latest assistant response with no newer user message can show it.
  After the run ends (including Stop/error), wait 15 continuous seconds with the
  result footer in view and the document visible. Typing resets this quiet interval. No modal, focus, scroll,
  notification, mandatory response, or free-text collection.
- An atomic display claim prevents another tab/device/reload asking again.
  The PostHog shown event is separate and requires the rendered question in view.
  A claim interrupted by navigation may remain selected but unshown: report it.
- Yes / Partly / No / Haven't checked yet; save the answer immediately. Reasons
  are optional and structured, with Skip. Dismiss/answer/view extends cooldown.
  Unshown invitations expire after 48 hours. Existing manual thumbs remain usable.
- Some failed runs never create a displayable assistant message; they remain in
  the selection denominator as unshown. Never claim the sample covers all failures.

## Persistence and attribution

`task_outcome_surveys` stores selection, view claim, answer and reason; user ID
indexes enforce ownership/cooldown and support account deletion. Surveys are
service-selected, client writes are authenticated and restricted to the owner,
answers are first-write-wins, and reasons must match the answer. Recovery updates
only message_id, retaining request_id, assignment and baseline. Provider/model
attempt history and final outcome join using experiment_request_id, rather than
copying streamed content into feedback. Authenticated frontend events use stable
UUIDs for retry deduplication. Browser analytics can be blocked: reconcile answer
counts with durable Convex records before an experiment conclusion.

PostHog events: `task_outcome_survey_selected`, `_shown`, `_dismissed`, `_answered`,
`_reason`. All have survey_key/version, experiment_key/variant/request_id,
message_id, chat_id, baseline_model, assigned_model, mode, subscription_tier and
release; answered/reason add only their structured codes. No prompts, target
URLs, findings, code, credentials or free-text feedback.

## Rollout and measurement

Owner Ross Manko; first review 2026-09-14, cleanup within 60 days or experiment end.
Flag `task_outcome_feedback_v1` is independent from provider assignment:

| Environment | PostHog project       | Flag ID | Initial state                                 |
| ----------- | --------------------- | ------- | --------------------------------------------- |
| Preview     | hackerai-dev / 401167 | 869527  | Active, 100% eligible test population         |
| Production  | HackerAI / 144137     | 869525  | Active, only designated internal test account |

Application additionally requires the existing paid/moderation experiment.
Selection checks the server flag; the browser displays only server-reserved
invitations because browser feature-flag fetching is disabled application-wide.
Missing or failed evaluation suppresses selection. Turning off the flag stops new
selections; already reserved invitations can appear until their 48-hour expiry.
It never changes the provider. For an immediate UI rollback, revert the component.
Backend schema/functions and both Vercel and Trigger code must deploy before
activation reaches users. Verify each runtime's PostHog and Convex targets
independently; the flags alone do not deploy code. No automatic public ramp.

Dashboard 2070216 contains prepared participation, answer and reason diagnostics.
Primary analysis must select each user's FIRST selected survey in the analysis
window, then left-link its view/answer. Include all selected users and report
shown/selected, answered/shown, dismissed/shown and missing ratings. Among assessed
answers, report Yes/(Yes+Partly+No), with Partly and No separate; Not checked is
unassessed. Never equate nonresponse or Stop with dissatisfaction. Report unique
respondents, confidence intervals and response-rate imbalance, excluding internal
allowlist users. Compare original randomized assignments and each baseline model
separately; do not pool Large v2 with base-model results. Secondary analyses can
use later responses with user-level clustering. Proposed worthwhile improvement:
+5 percentage points; plan sample size from observed response rate/baseline before
calling a winner. A week alone is not enough. D1/D7/D30 use mature windows.

Rollback the survey on repeated prompts, privacy/attribution defects or UI
interference. Cost and speed remain guardrails, not the primary success measure.

## Manual verification

Use a disposable paid Preview Agent chat with an authorized synthetic lab request
that enters the existing moderation experiment. Confirm survey selection precedes
provider attempts. Complete or stop the run, wait 15 seconds at its visible footer,
and verify the neutral inline prompt without focus/scroll changes. Test a narrow
viewport and keyboard-only interaction. Answer Partly then an optional reason;
verify persistence and the original assignment/request linkage in PostHog. Reload
and open another device/tab: no prompt repeats. Confirm failure/retry keeps the
same request assignment and updates message linkage. Disable the survey flag: no newly selected invitation (existing reservations
retain their 48-hour expiry). Provider routing stays unchanged.

## Implementation validation

Automated tests cover weekly cooldown, concurrent reservation/display claims,
owner authorization, expiry, structured reason validation, fallback message
linkage, visible-tab delay, typing delay, dismissal and no focus stealing. A real
local Convex backend in the HackerAI Development project verified concurrent
reservations, one-device display, persisted answer/reason and reload suppression.
Desktop and 390px browser checks verified the real prompt layout. A disposable
local fixture exercised the UI against that backend with synthetic identity;
its server selection and client events target development PostHog project 401167.
This does not establish the deployed Preview or Production chat/worker journey.
