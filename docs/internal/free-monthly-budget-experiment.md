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

Each runtime must have `FREE_QUOTA_GMAIL_CANONICALIZATION=true`, the shared Redis
migration state must be `complete`, and the normal monthly allowance must be
$0.25. A different operational budget override disables new enrollment. No
client-provided verification, country, allocation or dollar amount is accepted.
The authenticated web route forwards verification and consent-filtered country;
Trigger evaluates its own PostHog project. Old payloads lacking these facts do
not enroll. Approval revalidation and delegated runs retain the bounded policy
snapshot and still enforce current entitlement and stricter operational caps.

A domain-separated SHA-256 digest of the secret canonical quota subject selects
an enrollment bucket (0–9999) and an independent control/test arm. This keeps
Gmail aliases together without sharing quota hashes or emails with PostHog.
Only a coarse bucket, arm and eligibility boolean go to flag evaluation;
assignment properties are not persisted as person traits. WorkOS accounts and
billing/customer records remain separate. Analytics denominators are accounts,
not proven unique people; aliases can be correlated, so account observations
must not be treated as independent people in a significance claim.

PostHog release conditions must use **100% matching-condition rollout** and
explicit variant overrides matching `free_monthly_budget_arm`. The bucket
threshold controls overall enrollment. Do not use the ordinary per-account
percentage slider or randomized multivariate allocation: it could split aliases.
The evaluator rejects a variant that disagrees with the server's stable arm.
Increasing the threshold preserves previously assigned arms. Changing the
hash/arm algorithm requires a new experiment version.

| Project           | Flag                                                                 | State at PR preparation | Bucket threshold | Eligible allocation                       |
| ----------------- | -------------------------------------------------------------------- | ----------------------- | ---------------- | ----------------------------------------- |
| Preview 401167    | [885475](https://us.posthog.com/project/401167/feature_flags/885475) | Active                  | <10000           | 100%, approximately 50/50                 |
| Production 144137 | [885474](https://us.posthog.com/project/144137/feature_flags/885474) | Inactive                | <500             | 0% live; 5% proposed, approximately 50/50 |

These are separate definitions. Production activation follows internal QA,
verified Gmail migration and independent Vercel/Trigger deployment checks; it
is not implied by merging this PR. Initial public treatment is approximately
2.5% of eligible quota identities. No automatic ramp is implemented.

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
Trigger independently, including the actual worker project key and canonical
quota gate. Never copy credentials or ignored runtime state between environments.

Disable the flag to return new requests to $0.25 without clearing usage; users
already above $0.25 remain exhausted until the UTC calendar-month reset. An
in-flight run keeps its snapshot, including across approval waits and delegated
work. Do not lower an operational limit casually: it affects all free users.
After the reviewed result, remove the flag/code or adopt an explicitly approved
permanent policy through the issue's cleanup plan.

## Manual acceptance

On the verified Preview URL and its separately verified Trigger Preview worker:

1. Use disposable verified free accounts in each deterministic arm outside the
   excluded countries. Complete one bounded Ask reply and one Agent request;
   verify rendered nonempty responses, reload, exposure, outcomes and cost.
2. Seed only those disposable identities with $0.30 existing monthly spend.
   Control must block; treatment must have $0.20 remaining, using the same
   existing key/reset. At $0.50 both block. Exhaust daily units and confirm
   neither arm bypasses them; check shared Gmail aliases and concurrency.
3. Verify approval wait/reconnect and delegated work keep the policy and
   accumulated cost. Disable the flag and confirm new requests return to
   $0.25 without resetting prior spend.
4. Check unverified and paid accounts, IN/PK/BD/NG, unknown geography,
   explicit consent decline, EU missing consent, incomplete migration and
   unavailable flag service: no monthly experiment enrollment.
5. Read back both flag definitions and inspect actual exposure from web and
   Trigger separately. Keep Production disabled until these checks pass.
