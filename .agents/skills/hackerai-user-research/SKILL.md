---
name: hackerai-user-research
description: Run privacy-safe HackerAI customer research from a Linear question and a product-data cohort. Use for requests to understand user types, recurring jobs, workflows, friction, value drivers, reasons to pay, or customer avatars from actual HackerAI messages, including HAC-65-style top-spender research. Also use when a PM asks how to run, repeat, or interpret the `pm-user-research` Trigger task. Do not use for support investigations, decisions about one person's eligibility or risk, or exporting raw customer content.
---

# HackerAI User Research

Turn a research question and 3-20 internal user IDs into restricted per-user
profiles and an aggregated cohort report. The deployed task samples messages,
redacts sensitive data, and uses Grok 4.6 with reasoning disabled.

Read [references/privacy-policy.md](references/privacy-policy.md) and
[references/pm-runbook.md](references/pm-runbook.md) before running the task.

## Workflow

1. Read the owning Linear issue. Extract the research question, cohort rule,
   exclusions, requested output, and privacy constraints. Confirm the responsible
   owner explicitly approved customer-message research. If no approved issue
   exists, create or update one and stop until approval is recorded; creating the
   issue does not itself grant approval.
2. Select the cohort in PostHog. Use Stripe-synced revenue in PostHog when its
   freshness and account mapping are sufficient. Check Stripe directly only for
   unmatched customers, refunds/disputes, payer-versus-user ambiguity, or other
   reconciliation gaps. Never use Google Drive.
3. Resolve each cohort member to the internal user ID used by Convex. Exclude
   internal/test/fraud accounts and deduplicate payer or organization
   relationships before triggering analysis. Stop unless 3-20 unique internal
   user IDs remain after filtering.
4. Discover the Trigger task `pm-user-research` and inspect its current schema.
   Trigger it in the intended environment with the Linear issue ID, exact
   question, descriptive cohort label, 3-20 unique user IDs, PM name/handle, and
   optional chat limit. Never call the worker task directly.
5. Wait for the run to complete. Keep the returned `analysisId`; it is the audit
   and lookup key for the restricted Convex records.
6. Present only the aggregate answer, evidence coverage, supported user types,
   avatars, primary/secondary target, confidence, unknowns, and experiments.
   Detailed pseudonym-level profiles remain in restricted Convex records and are
   not returned through Trigger.
7. Update Linear only when asked. Copy aggregate findings, coverage, confidence,
   unknowns, and experiments. Never copy cohort IDs, pseudonym-level profiles,
   raw evidence, direct identifiers, or per-user findings or targeting decisions.

## Trigger payload

Use the current task schema as the authority. A typical HAC-65 run is:

```json
{
  "linearIssueId": "HAC-65",
  "question": "What kinds of users are our highest-spending customers, what recurring work do they use HackerAI for, and why do they pay?",
  "cohortLabel": "Top 10 users by reconciled lifetime net paid spend",
  "userIds": ["internal-user-id-1", "internal-user-id-2", "internal-user-id-3"],
  "requestedBy": "PM name or handle",
  "maxChatsPerUser": 12
}
```

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

The Trigger result contains only aggregate internal research. Detailed profiles
remain restricted and deletion-aware in Convex. The aggregate report is the only
part that may be copied to Linear, under the owning issue's privacy rules.
