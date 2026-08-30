---
name: hackerai-user-research
description: Run privacy-safe HackerAI customer research from an authorized PM question and a PostHog cohort. Use for requests to understand user types, recurring jobs, workflows, friction, value drivers, reasons to pay, or customer avatars from actual HackerAI messages, including top-spender research. Also use when a PM asks how to run, repeat, or interpret the `pm-user-research` Trigger task. Do not use for support investigations, decisions about one person's eligibility or risk, or exporting raw customer content.
---

# HackerAI User Research

Turn a research question and 3-20 internal user IDs into restricted per-user
profiles and an aggregated cohort report. The deployed task samples messages,
redacts sensitive data, and uses Grok 4.6 with low reasoning.

Read [references/privacy-policy.md](references/privacy-policy.md) and
[references/pm-runbook.md](references/pm-runbook.md) before running the task.

## Workflow

1. Extract the research question, cohort rule, exclusions, requested output, and
   privacy constraints from the authorized PM's request. Possession of the
   scoped PM gateway key establishes access to this workflow; do not ask for a
   separate per-run approval or inspect a Linear issue's state or comments for
   authorization. A Linear issue may be supplied only as optional tracking
   metadata.
2. Select the cohort entirely in PostHog. For spend-ranked research, use the
   available Stripe-synced revenue properties in PostHog without opening Stripe
   or requiring Stripe access. If PostHog cannot prove an exact accounting
   adjustment or payer mapping, use the best available PostHog cohort and state
   that limitation in the aggregate report instead of blocking the run. Never
   use Google Drive.
   Record the production PostHog project, cohort selection timestamp, a SHA-256
   fingerprint of the selection query, and any known selection limitations. Do
   not place the raw query in the gateway payload or report.
3. Resolve each cohort member to the internal user ID used by Convex. Exclude
   internal/test/fraud accounts and deduplicate payer or organization
   relationships before triggering analysis. For authenticated HackerAI users,
   select PostHog `distinct_id` as the internal Convex/WorkOS user ID; do not
   require a duplicate person property or infer identity from email. Stop unless
   3-20 unique internal user IDs remain after filtering.
   For event-based questions, also select the PostHog event timestamp for each
   user. Use it as that user's evidence anchor; do not substitute one shared
   timestamp for the cohort.
4. Create a mode-600 temporary JSON request outside the repository using the
   gateway payload below. Run
   `node .agents/skills/hackerai-user-research/scripts/run-research.mjs --payload <path>`.
   The runner requires `HACKERAI_PM_USER_RESEARCH_KEY` in the PM's Codex
   environment and always calls the production HackerAI gateway. Never print
   the key, put it in the request, or use Trigger
   dashboard access. Remove the temporary request after the command reads it.
5. Wait for the runner to return a completed result. Keep the returned
   `analysisId`; it is the audit and lookup key for the restricted Convex
   records. Do not substitute direct Trigger access if the gateway fails.
6. Present the returned internal Convex/WorkOS user IDs together
   with the aggregate answer, evidence coverage, supported user types, avatars,
   primary/secondary target, confidence, unknowns, and experiments. User IDs are
   ordinary cohort-selection output and must not be hidden or replaced with
   pseudonyms. Detailed profiles remain in restricted Convex records and are not
   returned through Trigger.
7. Update an optional Linear issue only when asked. Copy aggregate findings,
   cohort IDs, coverage, confidence, unknowns, and experiments. Never copy raw
   evidence, customer message content, secrets, or restricted profile records.
8. When the PM asks to continue the research in Slack, return one self-contained,
   paste-ready request that begins with `@codex Use $hackerai-user-research.`
   Include the authorized research question, cohort rule, every internal user ID,
   and each user's event anchor for event-based research. Include known event
   labels, such as cancellation reasons, when they help interpret the cohort.
   State the requested evidence window, aggregate output, and privacy constraints.
   Do not refer to IDs or context "above," and do not expect Slack Codex to infer
   or reselect the cohort. Tell Slack Codex to run the bounded gateway workflow;
   a Slack handoff is not permission to browse customer messages manually.

## Gateway payload

Use the current task schema as the authority. A typical run is:

```json
{
  "question": "What kinds of users are our highest-spending customers, what recurring work do they use HackerAI for, and why do they pay?",
  "cohortLabel": "PostHog top-spender research cohort",
  "userIds": ["internal-user-id-1", "internal-user-id-2", "internal-user-id-3"],
  "cohortSource": "posthog",
  "posthogProjectId": 144137,
  "cohortSelectedAt": 1788000000000,
  "selectionQueryFingerprint": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "selectionLimitations": ["Historical revenue coverage is incomplete"],
  "maxChatsPerUser": 12
}
```

For churn or another event-based question, add:

```json
{
  "samplingMode": "pre_event",
  "evidenceWindowDays": 60,
  "evidenceAnchors": [
    { "userId": "internal-user-id-1", "anchorAt": 1787702400000 },
    { "userId": "internal-user-id-2", "anchorAt": 1787788800000 },
    { "userId": "internal-user-id-3", "anchorAt": 1787875200000 }
  ]
}
```

`evidenceAnchors` must contain exactly one PostHog event timestamp for every
cohort user. Omit sampling fields for ordinary representative-history research.

`linearIssueId` may be added as an optional tracking reference, for example
`"linearIssueId": "HAC-65"`. Do not read the issue or its comments to look for
approval; its presence, state, and prior cohort notes never authorize or block a
run.

Do not place email addresses, billing customer IDs, or message content in the
payload. `userIds` must be the internal Convex/WorkOS user IDs.

## Quality checks

- Treat a profile as directional when fewer than three chats were available or
  confidence is low.
- Verify `usersAnalyzed`, `chatsReviewed`, and `messagesReviewed` before using a
  conclusion.
- Do not turn one-off requests into an avatar. Prefer patterns supported across
  multiple chats and users.
- Keep observed product behavior separate from acquisition or messaging
  hypotheses.
- Treat behavioral explanations of churn or conversion as low-confidence
  causal evidence even when pre-event sampling is used. Compare them with
  explicit survey reasons or a controlled experiment before making causal
  claims.
- Say `unknown` when the evidence does not establish context. Never infer a
  company or occupation from an email address.
- A failed or partial run is not permission to inspect messages manually. Fix
  cohort mapping or deployment/configuration and rerun the bounded task.

## Result boundary

The gateway returns internal cohort user IDs and aggregate research, and cannot
read other Trigger tasks or runs. Detailed profiles remain restricted and
deletion-aware in Convex. Display cohort IDs as normal research output. They may
also be copied to an optional Linear issue when requested. Raw customer content,
secrets, and restricted profile records remain protected by the same privacy
rules.
