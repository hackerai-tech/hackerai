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
customer IDs.

Record `posthogProjectId`, the cohort selection timestamp, a SHA-256 fingerprint
of the selection query, and short limitations that affect interpretation. Never
send the raw query. For event-based research such as churn, select the event
timestamp beside each user ID and provide it as that member's evidence anchor.
Use a bounded pre-event window; do not use one cohort-wide timestamp.

## 2. Run through Codex

Ask Codex:

> Use $hackerai-user-research. Select the PostHog top-spender cohort, run the
> analysis, wait for it, and give me the aggregate findings with coverage,
> confidence, unknowns, and recommended experiments.

Codex should proceed from the authorized PM's request without checking for
another approval. It should use the skill's `scripts/run-research.mjs` gateway
runner and wait for completion. The PM's Codex environment must contain the scoped
`HACKERAI_PM_USER_RESEARCH_KEY`; it must not contain Trigger or Convex service
keys. The runner always calls the production gateway at
`https://hackerai.co/api/internal/user-research`; no Preview URL or Preview PM
gateway key is required. The gateway can start and read only
`pm-user-research`, and it returns the cohort user IDs and aggregate result. The
task runs one parallel worker per user and a final cohort synthesis. Both calls use
`x-ai/grok-4.6` with OpenRouter reasoning set to low
and zero-data-retention routing required.

Create the temporary request JSON outside the repository with mode 600, pass its
path to the runner, then remove it. Never commit the request file. User IDs from
the completed result may be copied into Linear when requested.

The scoped gateway key authenticates the PM runner to the restricted production
endpoint. It is not a per-run approval and does not require a Linear issue.

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

Do not send a Slack request that merely says to analyze churn, refers to a cohort
"above," or expects Slack Codex to discover the IDs. Do not ask Slack Codex to
read messages directly. The request must tell it to use this skill and run the
bounded gateway workflow. If the Slack Codex environment lacks the scoped PM
gateway key, it must report that configuration blocker rather than browse
customer messages manually.

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
