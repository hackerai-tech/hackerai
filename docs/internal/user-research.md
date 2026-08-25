# Internal user research pipeline

The PM-facing entry point is the Trigger.dev task `pm-user-research`, normally
called through the repo-owned Codex skill `$hackerai-user-research`.

## What it does

1. Accepts an authorized PM's research question and 3-20 internal user IDs
   selected entirely from PostHog. The scoped PM gateway key establishes access;
   no separate per-run approval record is required. A Linear issue is optional
   tracking metadata and does not authorize or block a run.
2. Uses service-keyed Convex queries to sample up to 20 chats across each user's
   observed date range.
3. Reads bounded text excerpts from the beginning and end of each chat. It never
   returns files, tool outputs, reasoning parts, hidden/system messages, or IDs.
4. Redacts direct identifiers, targets, secrets, paths, code blocks, and command
   arguments before sending evidence to the model.
5. Runs one profile worker per user in parallel, then synthesizes the cohort.
6. Stores the audit record, structured pseudonymized profiles, aggregate report,
   evidence coverage, token usage, and provider cost in Convex.

Both stages use `x-ai/grok-4.6` through the existing OpenRouter
provider with reasoning set to low and zero-data-retention routing
required. The task fails closed if no ZDR-capable endpoint is available.

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

Every function requires the dedicated `CONVEX_USER_RESEARCH_SERVICE_KEY`; none
is intended for direct browser or PM access. This key must be distinct from
`CONVEX_SERVICE_ROLE_KEY` and from the value used in any other environment.

## Runtime requirements

The Trigger environment must have `NEXT_PUBLIC_CONVEX_URL`,
`CONVEX_USER_RESEARCH_SERVICE_KEY`, and the existing OpenRouter configuration
used by `lib/ai/providers.ts`. Configure the same dedicated research key on the
matching Convex deployment, but use independent values for Preview and
Production. Deploy the Trigger project after the application/Convex schema
reaches the target environment.

The Vercel Production environment also exposes a narrow PM gateway at
`/api/internal/user-research`. Configure only its Production
`PM_USER_RESEARCH_RUNNER_KEY_SHA256` with the SHA-256 digest of the scoped key
held by the PM. The gateway records `pm-gateway` as the requester, uses Vercel's
existing `TRIGGER_SECRET_KEY` server-side, can start only `pm-user-research`, and
returns status/output only for runs carrying its gateway tag. It never returns
task payloads, other runs, worker profiles, or provider diagnostics. The PM
runner uses the fixed production URL, so Preview needs no PM gateway URL or key.

## PM invocation

Invoke `$hackerai-user-research` in Codex with the research question and cohort
criteria. Codex must not ask for a separate per-run approval or inspect Linear
state or comments before running it. A Linear issue may be supplied only when
tracking is useful. The skill uses PostHog exclusively for cohort selection and
the scoped gateway runner to start and wait for `pm-user-research`. Spend-ranked
cohorts use the available Stripe-synced properties in PostHog; PMs do not need
direct Stripe access. If the available PostHog data has accounting or mapping
limitations, label them in the aggregate output instead of blocking the run. Do
not add PMs to the Trigger organization or give them Trigger/Convex credentials.

`HACKERAI_PM_USER_RESEARCH_KEY` authenticates the scoped runner; it is not a
per-run approval mechanism and is unrelated to Linear.
