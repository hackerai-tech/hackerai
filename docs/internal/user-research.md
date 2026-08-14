# Internal user research pipeline

The PM-facing entry point is the Trigger.dev task `pm-user-research`, normally
called through the repo-owned Codex skill `$hackerai-user-research`.

## What it does

1. Accepts an approved Linear issue, a research question, and 3-20 internal user
   IDs selected from PostHog/Stripe/account evidence.
2. Uses service-keyed Convex queries to sample up to 20 chats across each user's
   observed date range.
3. Reads bounded text excerpts from the beginning and end of each chat. It never
   returns files, tool outputs, reasoning parts, hidden/system messages, or IDs.
4. Redacts direct identifiers, targets, secrets, paths, code blocks, and command
   arguments before sending evidence to the model.
5. Runs one profile worker per user in parallel, then synthesizes the cohort.
6. Stores the audit record, structured pseudonymized profiles, aggregate report,
   evidence coverage, token usage, and provider cost in Convex.

Both stages use `x-ai/grok-4.6` through the existing OpenRouter provider with
reasoning explicitly disabled and zero-data-retention routing required. The task
fails closed if no ZDR-capable endpoint is available.

## Retention and deletion

Raw excerpts are not stored. Account deletion removes that user's
`research_user_profiles` and `research_run_members` records. Cohort-only
`research_runs` and `research_reports` remain retained; reports can be created
only after at least three user profiles are available.

## Convex functions

- `userResearch.createRun` and `markRunRunning`: create the auditable purpose and
  processing record.
- `userResearch.listRepresentativeChats`: select bounded chats across time.
- `userResearch.getMessageExcerpt`: return bounded, text-only conversation
  excerpts after ownership verification.
- `userResearch.saveUserProfile` and `listProfiles`: persist and read structured
  restricted profiles.
- `userResearch.completeRun` and `failRun`: finalize the report, cost, coverage,
  and status.

Every function requires `CONVEX_SERVICE_ROLE_KEY`; none is intended for direct
browser or PM access.

## Runtime requirements

The Trigger environment must have `NEXT_PUBLIC_CONVEX_URL`,
`CONVEX_SERVICE_ROLE_KEY`, and the existing OpenRouter configuration used by
`lib/ai/providers.ts`. Deploy the Trigger project after the application/Convex
schema reaches the target environment.

## PM invocation

Invoke `$hackerai-user-research` in Codex with the Linear issue. The skill uses
PostHog for cohort selection and Trigger MCP to discover, trigger, and wait for
`pm-user-research`. PostHog's Stripe sync can be the normal spend source; direct
Stripe access is only necessary for reconciliation gaps.
