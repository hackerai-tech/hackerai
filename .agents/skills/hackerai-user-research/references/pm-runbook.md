# PM runbook

## 1. Prepare the cohort

Start only after the responsible owner explicitly approves customer-message
research in the Linear issue. Creating or editing the issue is not approval. For
spend-ranked research, use
PostHog's Stripe-synced lifetime net paid amount when available and current.
Exclude refunds/disputes, internal and test users, fraud, duplicates, and
unmatched customers. Open Stripe only to resolve discrepancies or payer/account
ownership. Produce internal Convex/WorkOS user IDs, not emails or Stripe IDs.

## 2. Run through Codex

Ask Codex:

> Use $hackerai-user-research for HAC-65. Select the reconciled top-spender
> cohort, run the analysis, wait for it, and give me the aggregate findings with
> coverage, confidence, unknowns, and recommended experiments.

Codex should use the skill's `scripts/run-research.mjs` gateway runner and wait
for completion. The PM's Codex environment must contain the scoped
`HACKERAI_PM_USER_RESEARCH_KEY`; it must not contain Trigger or Convex service
keys. The runner always calls the production gateway at
`https://hackerai.co/api/internal/user-research`; no Preview URL or Preview PM
gateway key is required. The gateway can start and read only
`pm-user-research`, and it returns only the aggregate result. The task runs one
parallel worker per user and a final cohort synthesis. Both calls use
`x-ai/grok-4.6` with OpenRouter reasoning set to low
and zero-data-retention routing required.

The request JSON is temporary restricted data because it contains internal user
IDs. Create it outside the repository with mode 600, pass its path to the
runner, then remove it. Never commit it or copy it into Linear.

## 3. Interpret the result

Use the aggregate report to understand supported user types, customer avatars,
and decisions. Always include coverage and confidence. Detailed profiles remain
restricted in Convex. Treat acquisition channels and marketing messages as
hypotheses until a separate experiment validates them.

## 4. Share safely

Keep the gateway key, request payload, Trigger records, and Convex records
restricted. A Linear update may include only the aggregate answer, avatars,
coverage, confidence, unknowns, and experiments. Do not include the cohort IDs
or pseudonym-level profiles.
