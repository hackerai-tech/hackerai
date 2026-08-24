---
name: hackerai-user-research
description: Run privacy-safe HackerAI customer research from an authorized PM question and a product-data cohort. Use for requests to understand user types, recurring jobs, workflows, friction, value drivers, reasons to pay, or customer avatars from actual HackerAI messages, including top-spender research. Also use when a PM asks how to run, repeat, or interpret the `pm-user-research` Trigger task. Do not use for support investigations, decisions about one person's eligibility or risk, or exporting raw customer content.
---

# HackerAI User Research

Turn a research question and 3-20 internal user IDs into restricted per-user
profiles and an aggregated cohort report. The deployed task samples messages,
redacts sensitive data, and uses Grok 4.6 with low reasoning.

Read [references/privacy-policy.md](references/privacy-policy.md) and
[references/pm-runbook.md](references/pm-runbook.md) before running the task.

## Workflow

1. Extract the research question, cohort rule, exclusions, requested output, and
   privacy constraints from the authorized PM's request. A Linear issue may be
   supplied for optional tracking, but it is not an authorization control and
   must not be required to run research.
2. Select the cohort in PostHog. Use Stripe-synced revenue in PostHog when its
   freshness and account mapping are sufficient. Check Stripe directly only for
   unmatched customers, refunds/disputes, payer-versus-user ambiguity, or other
   reconciliation gaps. Never use Google Drive.
3. Resolve each cohort member to the internal user ID used by Convex. Exclude
   internal/test/fraud accounts and deduplicate payer or organization
   relationships before triggering analysis. Stop unless 3-20 unique internal
   user IDs remain after filtering.
4. Create a mode-600 temporary JSON request outside the repository using the
   gateway payload below. Run
   `node .agents/skills/hackerai-user-research/scripts/run-research.mjs --payload <path>`.
   The runner requires `HACKERAI_PM_USER_RESEARCH_KEY` in the PM's Codex
   environment and always calls the production HackerAI gateway. Never print
   the key, put it in the request, or use Trigger
   dashboard access. Remove the temporary request after the command reads it.
5. Wait for the runner to return a completed aggregate. Keep the returned
   `analysisId`; it is the audit and lookup key for the restricted Convex
   records. Do not substitute direct Trigger access if the gateway fails.
6. Present only the aggregate answer, evidence coverage, supported user types,
   avatars, primary/secondary target, confidence, unknowns, and experiments.
   Detailed pseudonym-level profiles remain in restricted Convex records and are
   not returned through Trigger.
7. Update an optional Linear issue only when asked. Copy aggregate findings,
   coverage, confidence, unknowns, and experiments. Never copy cohort IDs,
   pseudonym-level profiles, raw evidence, direct identifiers, or per-user
   findings or targeting decisions.

## Gateway payload

Use the current task schema as the authority. A typical run is:

```json
{
  "question": "What kinds of users are our highest-spending customers, what recurring work do they use HackerAI for, and why do they pay?",
  "cohortLabel": "Top 10 users by reconciled lifetime net paid spend",
  "userIds": ["internal-user-id-1", "internal-user-id-2", "internal-user-id-3"],
  "maxChatsPerUser": 12
}
```

`linearIssueId` may be added as an optional tracking reference, for example
`"linearIssueId": "HAC-65"`. The issue's presence or state does not authorize
or block a run.

Do not place email addresses, Stripe customer IDs, or message content in the
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
- Say `unknown` when the evidence does not establish context. Never infer a
  company or occupation from an email address.
- A failed or partial run is not permission to inspect messages manually. Fix
  cohort mapping or deployment/configuration and rerun the bounded task.

## Result boundary

The gateway returns only aggregate internal research and cannot read other
Trigger tasks or runs. Detailed profiles remain restricted and deletion-aware
in Convex. The aggregate report is the only part that may be copied to an
optional Linear issue, under the same privacy rules.
