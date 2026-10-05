# Post-task use-case research

Owner and rollout/readout plan: [HAC-144](https://linear.app/hackerai/issue/HAC-144).

Ask one optional question after a fresh submitted request finishes with `stop`
and visible answer text: “What are you mainly using HackerAI for?” The inline
card sits below the latest answer, leaves the composer available, and saves a
choice immediately. It replaces the dormant two-question acquisition popup.

The initial population is solo Free users within seven days of account creation
who permit analytics and have been identified by the analytics provider. Paid
users are excluded so this research does not compete with early paid-task
feedback. Cancelled, failed, still-running and history-only/reconnected responses
do not arm a new invitation. This is completion evidence, not proof that the
answer solved the task. These answers describe activated new Free respondents,
not all signups, paid users or a representative market sample.

## PostHog contract

Use a headless (`api`), once-only survey named `HackerAI primary use case v2`,
linked to `hac-57-post-activation-survey`, with exactly the question and ordered
choices in the application contract. “Something else” is a structured choice;
never enable an open choice. The server fetches public definitions using the
runtime's project token, validates the entire supported question contract, and
evaluates the linked and generated targeting flags for the authenticated user.
Client-wide feature flag polling stays disabled. Definitions cache for up to 60
seconds; audience decisions and the authenticated endpoint do not cache.

Responses live in PostHog Surveys; there is no new Convex table. `survey shown`
means at least half the card was visible in a visible tab, or the user interacted
with it. `survey sent` carries the actual `$survey_id`, question-ID response,
`$survey_submission_id`, `$survey_completed`, structured `use_case` and Ask/Agent
mode. Dismissal emits `survey dismissed`, never an answer. Stable authenticated
event UUIDs deduplicate repeated capture. No chat IDs, prompts, targets, findings,
code, uploaded content or free text are added.

Exposure suppresses another invitation in that browser for the same account;
other tabs close on a storage update. Answers/dismissals also set PostHog's native
person suppression properties and `marketing_use_case_survey_completed_v2`.
Target the linked flag to people without that property. Cross-device suppression
is eventual, and local storage can be unavailable; this is not an atomic global
one-invitation guarantee. A queued capture is not proof of remote delivery.

## Acceptance and teardown

Prepare separate survey definitions and flags in Preview `hackerai-dev` 401167
and Production `HackerAI` 144137. Preview uses 100% of app-eligible tests;
Production remains inactive at 0% until a separately approved internal rollout.
Keep both survey definitions as drafts while reviewing the PR. Enable Surveys in
the intended project and launch its definition only during approved acceptance.

Before live testing, verify that Vercel's Preview project token is the development
project token and resolve its designated Preview Convex account/deployment.
This survey runs in the browser/Vercel path and requires no Trigger code or
configuration change; do not infer or change Trigger's project from Vercel.

Use a fresh authorized Preview Free account to complete a disposable Ask request,
then a separate fresh account for Agent. Check the inline placement on desktop
and mobile, keyboard use, dismissal, a subsequent message, reload, another tab,
and the actual native PostHog response row. Also check consent denied, paid/team
accounts, old accounts, a cancelled request and flag off. Keep unanswered users
and missing events in reporting; compare subsequent use/conversion with mature
follow-up and an explicit assignment denominator, rather than only respondents.

To roll back, disable the linked flag **and** stop the survey in each environment.
Already rendered cards can remain until navigation/new submission; public
survey definitions can remain cached for 60 seconds. After the research readout,
remove the UI/flag path unless the owner explicitly renews the research.
