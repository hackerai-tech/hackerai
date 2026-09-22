# Verified free monthly budget experiment

[HAC-115](https://linear.app/hackerai/issue/HAC-115) owns the hypothesis,
allocation, cost guardrails, review dates and removal decision. This tests
$0.25 versus $0.50 of monthly raw provider/tool cost. Daily units, referrals,
models, pricing, paid accounts and existing usage/reset dates are unchanged.

## Eligibility and allocation

Both Ask and durable Agent evaluate `free_monthly_budget_v1` on the server.
Only authenticated free accounts whose WorkOS session has `emailVerified=true`
may enroll. The request must have a known Vercel ingress country and permitted
analytics consent. IN/PK/BD/NG and unknown countries are excluded even when the
regional flag is disabled, so neither regional arm overlaps. Adding a country
to regional eligibility also excludes it here; NG is reserved before that
separate rollout reaches every worker.

Enrollment is disabled in application code. The proposed pilot previously depended
on globally shared Gmail quota identities; that migration has been cancelled.
Do not enable enrollment by simply removing the hold. A future implementation
must define stable allocation, duplicate enrollment handling and cost guardrails
without changing existing quota identities or resetting historical usage.

The experiment remains a proposal owned by HAC-115. Its measurement contract and
allowance policy are retained below for a separately approved implementation.

## Measurement

`free_monthly_budget_exposed` fires at quota enforcement, before accept/reject,
with bounded flushing for rejected requests. It records actual exposure rather
than flag evaluation, and retains participants with no subsequent usage.
`free_monthly_budget_variant`, `free_monthly_budget_dollars`, version 1 and
`$feature/free_monthly_budget_v1` also accompany successful free responses,
Agent outcomes and usage cost. Model experiment properties remain independent.
No new prompts, chat contents, emails or quota hashes are sent.

Use [the readout query](free-monthly-budget-readout.sql) with first exposure,
equal follow-up windows and zero outcomes retained. It reports successful
nonempty response within 24 hours, return on days 2/7, monthly-budget-interrupted
Agent runs, seven-day paid conversion, serving cost and attributed subscription
revenue. Activation is a completed response proxy, not proof of task success.
Payment outcomes are attributed through the authenticated account ID; the
Stripe customer remains separate. Reconcile first-ever paid customers in Stripe
before labeling observed `free_to_paid` starts as first-ever purchases.

The query separates immature cohorts from zero outcomes and reports crossover.
Do not call an experiment complete after seven elapsed days: use the issue's
sample-size review and enough mature outcomes. Calendar-month resets and
pre-existing spend affect both arms; keep enrollment dates aligned and inspect
reset-boundary effects. A higher cap can unlock an already exhausted account.
Current provider accounting can overshoot a cap by in-flight work; these are
budget limits, not a guaranteed exact invoice ceiling. Review actual cost and
disable enrollment if spending exceeds the approved pilot guardrail.

## Deployment and rollback

New Vercel and Trigger deployments are required; no Convex deployment or schema
change is needed. Verify the authorized environment mapping before accessing
configuration, using the repository's environment-boundary instructions:

- Preview: HackerAI Developer account, team `hackerai-development`, project
  `hackerai-52290`, designated `diligent-blackbird-710`, URL
  `https://diligent-blackbird-710.convex.cloud`; PostHog 401167.
- Production: HackerAI account/team/project `hackerai`, `greedy-cod-889`, URL
  `https://greedy-cod-889.convex.cloud`, registered runtime custom domain
  `https://convex.haiusercontent.com`; app `https://hackerai.co`; PostHog 144137.

These expected identities do not replace a current read-back. Verify Vercel and
Trigger independently, including the actual worker project key and enrollment
gates. Never copy credentials or ignored runtime state between environments.

Disable the flag to return new requests to $0.25 without clearing usage; users
already above $0.25 remain exhausted until the UTC calendar-month reset. An
in-flight run keeps its snapshot, including across approval waits and delegated
work. Do not lower an operational limit casually: it affects all free users.
After the reviewed result, remove the flag/code or adopt an explicitly approved
permanent policy through the issue's cleanup plan.

## Manual acceptance for cancellation

On the verified Preview runtime and its separately verified Trigger worker, send
a bounded free Ask and Agent request. They must retain their existing email-based
quota subject, daily/monthly limits, cost settlement and concurrency protection.
No monthly budget experiment exposure should be emitted, even if the remote
flag is active. Existing usage must remain consumed after reload.
