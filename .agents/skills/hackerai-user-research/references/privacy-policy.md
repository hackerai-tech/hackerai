# Customer research privacy policy

Use customer messages only for a specific internal research purpose requested by
an authorized PM using the scoped PM gateway. The request must define the cohort
and intended output. Do not require a separate per-run approval record or check
Linear status or comments. A Linear issue is optional tracking metadata only.

## Allowed

- Product behavior: recurring jobs, Ask/Agent usage, workflow stages, broad tool
  or environment categories, friction, value, and reasons to pay.
- Analyst-visible per-user profile content uses generated pseudonyms. Restricted
  Convex records retain the internal user ID needed for deletion and lifecycle
  handling; never expose the pseudonym-to-user linkage.
- Cohort-level avatars, confidence, unknowns, and testable hypotheses.

## Prohibited

- Sensitive-trait, demographic, health, political, religious, sexual, or other
  personal profiling.
- Inferring identity, employer, company, occupation, geography, or legitimacy
  from an email address or isolated clue.
- User contact, sales outreach, public marketing claims, eligibility decisions,
  fraud decisions, or adverse actions based on this research.
- Copying cohort IDs, pseudonym-level profiles, raw prompts, transcripts, direct
  quotes, identifiers, evidence, files, code, commands, payloads, secrets, or
  per-user targets, findings, or targeting decisions into Linear or task output.
- Sanitized aggregate report fields may be copied to an optional Linear issue.
- Manual browsing as a fallback when the bounded task fails.

## Storage and deletion

Raw message excerpts exist only in the analysis worker's memory and model
request. Model calls require an OpenRouter zero-data-retention route and fail
closed if no eligible Grok 4.6 endpoint is available. Convex stores the
run audit, pseudonymized structured profiles, and the aggregate report. Account
deletion removes that user's stored profile and run-membership linkage; runs and
reports are retained only as cohort-level outputs from cohorts of at least
three.
