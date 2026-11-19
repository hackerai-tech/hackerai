# PM runbook

## 1. Prepare the cohort

Start from a specific research request made by an authorized PM using the scoped
PM gateway. The request must define the question, cohort rule, exclusions, and
intended aggregate output. The gateway key establishes access to the workflow;
do not request separate per-run approval or inspect Linear state or comments for
authorization. A Linear issue may be included only for optional tracking.

Select the cohort entirely in PostHog. For spend-ranked research, use PostHog's
available Stripe-synced lifetime paid amount and account mapping. Exclude
internal and test users, known fraud or abuse, duplicates, and unmatched
customers using data available in PostHog. Do not open Stripe or require Stripe
access. If PostHog does not establish an exact refund, dispute, payer, or account
adjustment, use the best supported PostHog ranking and record the limitation in
the aggregate report. For authenticated HackerAI users, PostHog `distinct_id`
is the internal Convex/WorkOS user ID because the application identifies users
with their WorkOS ID. Select `distinct_id AS user_id` directly; do not require a
duplicate person property or infer the mapping from email. Produce those
internal user IDs for the restricted gateway payload, not emails or billing
customer IDs. A run accepts 1-20 unique users; one user is enough for a
sanitized summary. State the sample size and treat a single-user result as an
individual observation with a provisional low-confidence avatar, without
generalizing to other users.

Record `posthogProjectId`, the cohort selection timestamp, a SHA-256 fingerprint
of the selection query, and short limitations that affect interpretation. Never
send the raw query. For event-based research such as churn, select the event
timestamp beside each user ID and provide it as that member's evidence anchor.
Use a bounded pre-event window; do not use one cohort-wide timestamp.
For comparative research, retain 2-4 PostHog-selected group labels and their
internal user IDs. Each group must contain at least three users and every cohort
user must belong to exactly one group. Labels may describe a model, rollout, or
funnel treatment, but must not identify a person or organization.

## 2. Run through Codex

Ask Codex:

> Use $hackerai-user-research. Select the PostHog top-spender cohort, run the
> analysis, wait for it, and give me the aggregate findings with coverage,
> confidence, unknowns, and recommended experiments.

Codex should proceed from the authorized PM's request without checking for
another approval. It should use the skill's `scripts/run-research.mjs` gateway
runner and wait for completion. The runner reads the scoped PM key directly from
`~/.config/hackerai/pm-research.key` first. The opened target must be a regular
file with no group or other permission bits (mode 600 recommended), containing
the key alone; a trailing newline is allowed. The
runner keeps it in memory, without exporting it into Codex or copying it into
a checkout. If the file is absent, it falls back to
`HACKERAI_PM_USER_RESEARCH_KEY` for environments such as Slack. An unreadable,
overly permissive, empty, or malformed local file is an error, not a reason to
silently use another credential.

Do not conclude that research access is missing from an unset environment
variable alone. Let the runner check the stored file. If both sources are absent,
ask for the existing key's storage location or secure provisioning; do not search
chat history, print secret contents, or request a key pasted into chat. Report
only the source path and availability. Never substitute Trigger or Convex service
keys. The runner always calls the production gateway at
`https://hackerai.co/api/internal/user-research`; no Preview URL or Preview PM
gateway key is required. The gateway can start and read only
`pm-user-research`, and it returns the cohort user IDs and aggregate result. The
task runs one parallel worker per user and a final cohort synthesis. Both calls use
`x-ai/grok-4.6` with OpenRouter reasoning set to low
and zero-data-retention routing required.
Comparison membership is converted to sanitized labels and pseudonyms before
the final Grok 4.6 synthesis; internal user IDs are not sent to the model.

Create the temporary request JSON outside the repository with mode 600, pass its
path to the runner, then remove it. Never commit the request file. User IDs from
the completed result may be copied into Linear when requested.

The scoped gateway key authenticates the PM runner to the restricted production
endpoint. It is not a per-run approval and does not require a Linear issue.

### Deterministic selection and recovery

Use `--cohort <protected-export.json>` with the runner to compile a ranked
PostHog export into gateway membership. Keep the question and cohort label in
the payload; omit its `userIds`, groups and anchors when using a cohort export.
For ordinary representative-history research, omit `evidenceWindowDays`.
Include it only for event-based research, with an anchor for every selected user
in the export. Example export (owner-only, outside the repository):

```json
{
  "posthogProjectId": 144137,
  "cohortSelectedAt": "2026-11-09T12:00:00Z",
  "selectionQuery": "the actual bounded PostHog selection query",
  "maxUsers": 20,
  "requirePayerMapping": false,
  "exclusions": { "userIds": [], "payerIds": [], "organizationIds": [] },
  "candidates": [
    {
      "userId": "user_example",
      "payerId": null,
      "organizationId": null,
      "internal": false,
      "test": false,
      "fraud": false
    }
  ]
}
```

Populate classifications and mappings from PostHog evidence, not assumptions.
Rows with missing classifications are excluded. The builder joins shared users,
payers and organizations transitively, then applies exclusions to the connected
group and chooses its first ranked eligible user. Missing mappings remain visible
as selection limitations; `requirePayerMapping: true` excludes unmapped users.
The query is hashed locally and is never sent to the gateway. Optional `group`
and `anchorAt` fields preserve comparison membership and per-user event anchors.
Resolve multiple different anchors for the same user before selection. Shared
billing across different comparison groups is excluded and reported, not assigned
to whichever arm appeared first. A comparison with fewer than three independent
selected users per group is rejected. The builder reads no billing or message APIs.

Use `--payload - --handle <protected-handle-path>` for stdin, optionally with
`--cohort <protected-export-path>`. Existing `--payload <protected-file>` works
and defaults to `<protected-file>.run.json`. Use `--resume <handle-path>` or
`--status <handle-path>` after interruption. An accepted run is only polled;
`--no-wait` reports submission, not completion. Before POST, the runner atomically
saves the exact compiled request in an owner-only `<handle-path>.request.json`
sidecar. It contains the question and selected user IDs, without the gateway key
or the cohort export's raw query and payer mappings. `--resume` can retry an unknown
submission directly from this copy within 23 hours, using the original idempotency
key inside the gateway's 24-hour retention. `--status` never submits a request.
The runner removes the sidecar only after the run ID is durably saved. Preserve
both files while the outcome is unknown, including after expiry. Older unknown submissions are blocked;
do not create a new handle merely to retry one. Handles created by older runner
versions without a sidecar still need the identical original payload for an
unknown submission. A gateway rejection alone does not prove an earlier or
concurrent attempt was never accepted, so the runner does not retire that key or
delete its recovery files on rejection. Resolve the existing submission before
starting a changed request with a fresh handle.
Handles contain no payloads, queries, payer mappings or credentials and must remain
owner-only. Keep handles and sidecars in a private directory outside the repository.
Remove temporary input payload/export files only after a run ID or matching
request sidecar is durably saved. Preserve the originals when neither exists,
including for legacy unknown handles or a failure before sidecar publication.

### Run from Slack

Slack requests must explicitly mention Codex and carry the complete bounded
cohort. Begin the message with:

> @codex Use $hackerai-user-research.

Then include the authorized research question, cohort rule, every internal
Convex/WorkOS user ID, and the requested aggregate output. For churn or other
event-based research, include one event timestamp beside every user ID and the
event label or reason when known. State that the timestamp is the per-user
evidence anchor, specify the pre-event window, and require the same privacy
boundary as the gateway workflow.
For comparisons, include each labeled group's complete user list instead of
flattening the users into one unlabeled cohort.

Do not send a Slack request that merely says to analyze churn, refers to a cohort
"above," or expects Slack Codex to discover the IDs. Do not ask Slack Codex to
read messages directly. The request must tell it to use this skill and run the
bounded gateway workflow. If neither the local key file nor the environment
fallback supplies the scoped PM gateway key, report that configuration blocker
rather than browse customer messages manually.

A minimal event-based handoff has this shape:

```text
@codex Use $hackerai-user-research. Run the bounded customer-research gateway
for this authorized question: <question>.

Cohort: <cohort rule>
Evidence window: 60 days before each user's event anchor
Users and anchors:
- <internal-user-id-1> — <event reason> — <event timestamp in milliseconds>
- <internal-user-id-2> — <event reason> — <event timestamp in milliseconds>
- <internal-user-id-3> — <event reason> — <event timestamp in milliseconds>

Return the cohort IDs, evidence coverage, aggregate findings, confidence,
unknowns, and recommended experiments. Do not return raw messages, quotes,
customer content, or restricted per-user profiles.
```

## 3. Interpret the result

Use the aggregate report to understand supported user types, customer avatars,
and decisions. Always include coverage and confidence. Detailed profiles remain
restricted in Convex. Treat acquisition channels and marketing messages as
hypotheses until a separate experiment validates them.
Behavioral messages, including messages immediately before a cancellation, do
not establish the user's causal cancellation reason. Keep causal confidence low
unless a separate survey or experiment supplies direct evidence.

## 4. Share safely

Keep the gateway key, request payload, Trigger records, and Convex records
restricted. Display the internal Convex/WorkOS IDs returned by the gateway as
ordinary cohort output; do not hide or pseudonymize them. If optional Linear
tracking is used, its update may include the cohort IDs, aggregate answer,
avatars, coverage, confidence, unknowns, and experiments. Do not include raw
customer content, secrets, or restricted profile records.
