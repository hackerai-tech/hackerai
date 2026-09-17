# Regional free allowance policy

Owner and historical decision record: [HAC-104](https://linear.app/hackerai/issue/HAC-104).
The owner selected the lower allowance as a permanent regional policy and closed
the [allowance experiment](https://us.posthog.com/project/144137/experiments/462736)
early. Cost savings were supported in the interim readout; paid conversion and
revenue were inconclusive. Do not describe this as a proven overall business win.
The decision record contains the dated readout and deployment acceptance.

## Scope and enforcement

Authenticated free accounts with trusted Vercel ingress country `IN`, `PK`, `BD`,
or `NG` and analytics allowed receive at most three shared Ask/Agent requests per
day and $0.10 in tracked provider/tool cost per calendar month. Stricter runtime
configuration takes precedence. Paid accounts, consent opt-outs, unknown country,
out-of-region accounts and requests outside trusted Vercel ingress keep their
established allowances. Location reflects the connection, not residence; VPNs
and travel affect eligibility.

The policy no longer depends on PostHog availability or flag assignment.
The web route derives consent-aware country from `x-vercel-ip-country`; neither
client JSON nor `cf-ipcountry` may select a regional policy. The trusted Trigger
worker receives that country and derives the same policy from current plan and
runtime caps. Local/desktop Agent transports retain this server-side enforcement.

Existing identity-scoped usage counters, UTC resets and earned referral credits
are preserved. Policy changes do not reset usage. Accounts above the monthly cap
are blocked immediately; in-flight calls may exceed the nominal budget. Agent
preflight, approval revalidation, continuation and delegated child execution keep
the same policy snapshot. Already-running workers retain their deployed behavior.
Paid entitlements, model eligibility and safety gates are unchanged.

Usage telemetry retains coarse country, applied caps and
`regional_free_policy_version`. New requests do not emit
`regional_free_limits_exposed`, `regional_free_variant`, or
`$feature/regional_free_limits_v1`. Historical experiment data remains available.

## Deployment and retirement

Deploy both Vercel and Trigger; success in one does not prove the other is current.
Verify their environment identities independently before configuration access:
Preview belongs to the HackerAI Developer Convex account, while Production belongs
to the HackerAI account. Do not copy credentials or configuration between them.
No Convex schema/configuration migration is required for this policy.

Once flag-independent code is deployed, disable/archive `regional_free_limits_v1`
separately in Preview PostHog project `401167` (flag `875174`) and Production
project `144137` (flag `875171`). Preserve the experiment's historical results and
record the final definitions in HAC-104. Archived flags cannot roll this policy
back: revert the policy code and redeploy both Vercel and Trigger if needed.

The independent subscription-first experiment is not enabled by this closeout.
Any later launch needs its own reviewed decision and must account for the new
regional allowance baseline.

## Acceptance

On the actual Preview URL and then `hackerai.co`, use a disposable eligible free
account from trusted IN/PK/BD/NG ingress. Complete a bounded Ask request and an
Agent request through a connected local/desktop sandbox, reload the responses,
and retry at exhaustion. Both modes must share the reduced allowance without
resetting counters; earned referral credits can permit additional requests.
Exercise approval/resume and continuation when applicable. Check the monthly cap
against existing spend without resetting usage.

Confirm a paid account, consent opt-out and out-of-region account retain normal
behavior. New usage events must contain policy dimensions without ended
experiment attribution. Confirm the regional policy still applies with the flag
archived, and check the actual Trigger worker version separately from Vercel.
