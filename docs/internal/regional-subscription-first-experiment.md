# Subscription before regional task usage

Decision record and owner: [HAC-118](https://linear.app/hackerai/issue/HAC-118),
Ross Manko. The owner authorized a Production 50/50 control/test rollout.
Activation follows verified deployment and acceptance; HAC-118 records live state.

## Policy

`regional_subscription_first_v1` assigns authenticated free accounts from
trusted Vercel ingress countries IN/PK/BD/NG with analytics allowed. A missing,
disabled or unavailable flag, declined consent, unknown geography and paid
accounts preserve existing access. Location reflects a connection, not residence.
The browser never supplies authoritative country, assignment or subscription.

Test users see their existing server-selected monthly Pro price before the idle
composer. Checkout and alternative plans use the existing subscription flow.
No regional discount or free renewal is offered. Ask, the Agent endpoint and
the worker reject test requests before model/tool execution. The Agent route
rejects before saving the message or dispatching a worker. The new gate does not
consume/refund existing quota or referral credits. Those credits do not bypass
the subscription requirement. History and account/billing surfaces stay available.
In-progress tasks keep their controls and existing run policy; new requests
reevaluate eligibility. Paid entitlement changes immediately remove the UI gate.

Control accounts keep the permanent regional allowance: at most three shared
Ask/Agent requests/day and $0.10/calendar month, including stricter operational
limits and existing referral credits. Enrollment never bypasses this policy.
Disabling this flag restores the same allowance on new work without resetting
counters. HAC-104 is closed; do not restart its archived allowance experiment.
If historical participants enter this test, label their later outcomes as affected
by subscription-first rather than an uninterrupted allowance follow-up.

## Rollout and environments

Preview project `401167` uses independent flag `887004` at 100% eligible forced
test. Production project `144137` uses flag `886891`: the approved target is
100% eligible enrollment with stable control/test allocation of 50/50. The actual
active state, rollout, targeting and launch timestamp are recorded in HAC-118
after read-back, rather than inferred from this document.

Both flags target `subscription=free` and `regional_subscription_country` in
IN/PK/BD/NG. Assignment is deterministic by WorkOS user ID. The worker derives its
assignment using its own PostHog project and the route's trusted country payload.
This requires new Vercel and Trigger deployments; later flag changes apply to
new requests/runs. Browser presentation refreshes on focus or reload.

Before deployment verification, independently establish Vercel Preview and
Trigger Preview use PostHog 401167 and the designated HackerAI Developer Preview
Convex account/deployment. The documented mapping is team
`hackerai-development`, project `hackerai-52290`, `diligent-blackbird-710`,
`https://diligent-blackbird-710.convex.cloud`. Do not use a production-labeled
deployment in that account or copy environment state from another checkout.
The existing Vercel Preview build can override that default with a branch Preview
deployment. Verify its account, project and branch in the Convex dashboard and
match the build logs, browser connection and Trigger payload before testing.
No Convex changes are needed. A flag definition alone does not establish a
worker's environment selection.

Before public enrollment, complete Preview checkout, payment activation, direct
API enforcement and rollback acceptance, verify both runtime identities, and
complete CI/review. The owner-approved 50/50 split supersedes the earlier 10%
enrollment proposal; do not reinterpret it as 50% enrollment split in half.

## Measurement and decision

`regional_subscription_first_exposed` records actual composer presentation or
task enforcement, with variant, coarse country, subscription tier and
`exposure_surface` (`composer`, `ask`, `agent`, `agent_worker`). A GET assignment
lookup alone is not exposure. Test composer exposure waits until a valid price
is shown; report pricing failures/assignment-to-exposure loss separately.

Use first exposure by account, retain participants with zero subsequent usage,
and attribute later cost and subscription revenue by that identity. Compare
matching follow-up windows, countries and exposure surfaces. Existing Pro-price
experiments remain independent; stratify by displayed price in the readout.
Never send prompts, targets, IP addresses or other user content as telemetry.

Primary: 30-day contribution per exposed account (collected attributed revenue
minus serving cost, refunds, payment fees and attributable acquisition cost).
Reconcile shared overhead separately and do not count worker/sandbox cost twice.
Guardrails include total contribution, conversion/revenue per exposed account,
checkout errors, paid/out-of-country restrictions, assignment balance and access
after payment. Review leading outcomes at 14 days and matured outcomes at 30 days
after the actual launch, recorded in HAC-118.

Rollback immediately for paid/out-of-scope restriction, broken checkout or task
access after payment. Stop if lost revenue exceeds serving-cost savings. Disable
the flag to restore new-request access without clearing counters. After the
30-day decision, remove both flags and code or replace them with an explicitly
approved permanent policy.

## Manual acceptance on the actual Preview URL

1. With a disposable eligible free account, confirm the monthly price agrees
   with checkout. Compare plans, cancel checkout, reload and verify no free task
   starts. Verify the same on narrow mobile layout and desktop client.
2. Submit a bounded Ask request and local/desktop Agent request directly to the
   APIs. Both must return `subscription_required`; no chat/message or worker run
   should be created by the rejected request. Verify the worker independently.
3. Complete a test-mode subscription through the existing checkout. The composer
   must become available; complete a bounded Ask and Agent task and reload each
   response. A pricing error must leave checkout disabled with a retry action.
4. Test control, paid, out-of-region, unknown-country and declined-consent
   accounts. Confirm original access and a complete bounded task. History and
   stop/reconnect controls for existing runs must remain accessible.
5. Check exposure properties and zero-usage participants. Disable the Preview
   flag, focus/reload and confirm restored access; restore forced-test Preview
   configuration after QA. Activate Production only after the verified deployment and acceptance.
