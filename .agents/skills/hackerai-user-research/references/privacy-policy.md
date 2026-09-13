# Customer research privacy policy

Use customer messages only for a specific internal research purpose requested by
an authorized PM using the scoped PM gateway. The request must define the cohort
and intended output. Do not require a separate per-run approval record or check
Linear status or comments. A Linear issue is optional tracking metadata only.

## Allowed

- Product behavior: recurring jobs, Ask/Agent usage, workflow stages, broad tool
  or environment categories, friction, value, and reasons to pay.
- Internal Convex/WorkOS user IDs selected from PostHog are ordinary research
  output. Display them with cohort results and include them in requested Linear
  updates; do not hide or replace them with pseudonyms.
- Restricted Convex records retain the internal user ID needed for deletion and
  lifecycle handling.
- Sanitized research summaries from 1-20 users, with confidence, unknowns, and
  testable hypotheses. Single-user summaries must state their sample size and
  must not be presented as established customer segments.

## Prohibited

- Sensitive-trait, demographic, health, political, religious, sexual, or other
  personal profiling.
- Inferring identity, employer, company, occupation, geography, or legitimacy
  from an email address or isolated clue.
- User contact, sales outreach, public marketing claims, eligibility decisions,
  fraud decisions, or adverse actions based on this research.
- Copying restricted profiles, raw prompts, transcripts, direct quotes,
  evidence, files, code, commands, payloads, secrets, targets, or customer
  message content into Linear or task output.
- Sanitized aggregate report fields may be copied to an optional Linear issue.
- Manual browsing as a fallback when the bounded task fails.

## Storage and deletion

Raw message excerpts exist only in the analysis worker's memory and model
request. Model calls require an OpenRouter zero-data-retention route and fail
closed if no eligible Grok 4.6 endpoint is available. Convex stores the run
audit, structured per-user profiles keyed by internal user ID, and the aggregate
report. Account deletion removes that user's stored profile and run-membership
linkage; runs and sanitized reports are retained, including reports based on
one user. Raw evidence and restricted profile records are never returned in
these reports.
