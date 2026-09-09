# Regional free allowance experiment

Owner and decision record: [HAC-104](https://linear.app/hackerai/issue/HAC-104/experiment-regional-free-allowance-for-india-pakistan-and-bangladesh).

Hypothesis: a smaller free allowance in India, Pakistan and Bangladesh lowers
serving cost per exposed account without losing enough paid conversion/revenue
to outweigh the savings. This is a hypothesis, not a conclusion from traffic or
cancellation data. Initial review is September 23, 2026, with a conversion
follow-up September 30. Leave the issue open until the readout is reviewed.

## Eligibility and treatment

Only authenticated free accounts with a Vercel ingress country of `IN`, `PK`,
or `BD` and analytics allowed are eligible. Vercel sets `x-vercel-ip-country`;
client JSON and `cf-ipcountry` cannot enroll an account. Outside Vercel,
unknown country, declined consent, paid tiers and failed/disabled flag lookup
all retain normal limits. Location reflects the current connection, not
residence; VPNs and travel affect eligibility.

`regional_free_limits_v1` assigns by WorkOS user ID, independently of the
existing model-routing experiments. Assignment is stable across new requests
and the web/Trigger services. The web route forwards only the eligible coarse
country to the trusted worker; the worker evaluates its own PostHog project.

| Variant | Daily shared Ask/Agent requests          | Calendar-month provider/tool cost        |
| ------- | ---------------------------------------- | ---------------------------------------- |
| control | Configured normal allowance (default 10) | Configured normal budget (default $0.25) |
| test    | At most 3                                | At most $0.10                            |

Existing stricter configuration takes precedence. Both variants use the same
identity-scoped usage counters, UTC resets and earned referral bonuses. Joining
the test does not clear prior usage: accounts already above the treatment budget
hit the limit immediately. Cost enforcement uses the existing usage accounting
and budget checkpoints; in-flight calls can exceed a nominal budget. Paid
entitlements, model eligibility and moderation behavior remain unchanged.

Agent preflight, post-approval revalidation and delegated child starts receive
the same policy. The country and assignment are never accepted from client
request bodies. Child/continued runs receive only the parent's internal policy.

## Measurement

The `regional_free_limits_exposed` event fires when quota enforcement is
encountered, including rejected attempts. It does not fire merely because a
flag is evaluated. Properties include `$feature/regional_free_limits_v1`,
`regional_free_variant`, `regional_free_country`, both applied limits and mode.
There are no IP addresses, prompts, answers or written customer feedback.

Existing `hackerai-usage_cost` events receive these additional dimensions without
overwriting model-routing experiment properties. PostHog's custom exposure
configuration attributes later outcomes by the same user ID, including users
with no subsequent usage (zero-cost participants). Do not divide costs by usage
events: that would omit users blocked by the policy and bias the comparison.

Production [experiment 462736](https://us.posthog.com/project/144137/experiments/462736):

- Primary: free serving cost per exposed account, sum of `cost_dollars` where
  `subscription_tier=free`.
- Guardrail: `subscription_started` with `conversion_type=free_to_paid`.
- Guardrail: attributed subscription revenue per exposed account from the same
  conversion event's `attributed_revenue_dollars` (not total lifetime revenue).
- Operational readout: assignment ratio and country coverage, existing
  `limit_hit`, `hackerai-agent_run` success, errors and request completions.

Compare matched follow-up windows, inspect the country breakdown and report
sample sizes. Do not decide from fewer requests alone. Stop for any paid or
out-of-country restriction, broken chat/Agent flow, inconsistent enforcement,
or clear conversion/revenue harm that exceeds savings. Review exposure loss
from consent, unknown geography and flag failures separately from control.

## Environment and rollout

| Environment | PostHog project       | Flag ID | Enrollment                            | Split                  |
| ----------- | --------------------- | ------- | ------------------------------------- | ---------------------- |
| Preview     | hackerai-dev / 401167 | 875174  | 100% code-eligible QA population      | Forced test            |
| Production  | HackerAI / 144137     | 875171  | 100% eligible population after launch | 50% control / 50% test |

Production flag stays disabled until the PR and deployment pass verification.
Vercel project `hackerai` belongs to the HackerAI team and is connected to
`hackerai-tech/hackerai`. Trigger project is `proj_fixirhycbcnfdpicejfb`.
Verified environment boundaries:

- Preview: Convex team `hackerai-development`, project `hackerai-52290`,
  designated deployment `diligent-blackbird-710`,
  `https://diligent-blackbird-710.convex.cloud`. Both Vercel Preview and Trigger
  Preview use this URL and the PostHog 401167 key.
- Production: Convex team/project `hackerai`, designated deployment
  `greedy-cod-889`, `https://greedy-cod-889.convex.cloud`, with the registered
  Convex Cloud custom domain `https://convex.haiusercontent.com`. Both Vercel
  Production and Trigger Production use the custom domain. The user-facing
  production domain is `https://hackerai.co`.

This change needs new Vercel and Trigger deployments. No Convex schema or
configuration change is required. Flag updates affect new requests/runs;
already-running tasks retain their policy snapshot. Disable the production flag
to restore normal limits on new requests, without clearing usage counters.

## Verification and cleanup

Automated tests cover each target country, excluded countries, all paid tiers,
consent denial, missing/error/disabled flags, stricter overrides, shared
Ask/Agent counters, monthly existing-spend handling and rollback without reset.

Manual verification on the PR Preview URL:

1. Use a disposable free account connecting from IN/PK/BD with analytics allowed.
   Send three short Ask/local-Agent requests; the next request must show the
   existing upgrade/reset message, unless earned referral credits remain.
2. Reload and retry. Usage must remain exhausted; changing mode must not reset it.
3. Verify a paid account and an account outside the target countries can complete
   a chat, reload its response and continue normally.
4. Confirm Preview exposure and usage events have the test variant and country;
   compare displayed limits with the actual enforcement. Exercise an Agent run
   and approval/resume when a connected local sandbox is available.
5. After production launch, verify both control and test exposure, 50/50 expected
   assignment, country coverage and conversion attribution. Do not manufacture
   purchases or customer activity to populate the readout.

After the reviewed decision, remove the code and both flags if unsuccessful,
or replace them with an explicitly approved permanent policy. Do not ship a
winning variant or expand targeting automatically.
