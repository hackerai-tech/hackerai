# Subscription before regional task usage

Decision record and owner: [HAC-118](https://linear.app/hackerai/issue/HAC-118),
Ross Manko. This PR prepares a test; it does not launch Production.

## Policy

`regional_subscription_first_v1` assigns authenticated free accounts from
trusted Vercel ingress countries IN/PK/BD/NG with analytics allowed. A missing,
disabled or unavailable flag, declined consent, unknown geography and paid
accounts preserve existing access. Location reflects a connection, not residence.
The browser never supplies authoritative country, assignment or subscription.

Test users see their existing server-selected monthly Pro price before the idle
composer. Checkout and alternative plans use the existing subscription flow.
No regional discount or free renewal is offered. Ask, both Agent endpoints and
the worker reject test requests before model/tool execution. The Agent route
rejects before saving the message or dispatching a worker. The new gate does not
consume/refund existing quota or referral credits. Those credits do not bypass
the subscription requirement. History and account/billing surfaces stay available.
In-progress tasks keep their controls and existing run policy; new requests
reevaluate eligibility. Paid entitlement changes immediately remove the UI gate.

Controls use the configured ordinary free allowance. Both enrolled arms skip
the older regional and monthly free-budget experiments. **Do not publicly launch
while HAC-104 is running:** this would contaminate its cost/conversion readout.
Disabling this flag restores the preexisting allowance experiments on new work.

## Rollout and environments

| Environment | Project               | Flag   | Active | Enrollment       | Split               |
| ----------- | --------------------- | ------ | ------ | ---------------- | ------------------- |
| Preview     | hackerai-dev / 401167 | 887004 | Yes    | 100% eligible QA | Forced test         |
| Production  | HackerAI / 144137     | 886891 | No     | 0%               | 50/50 when enrolled |

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

Before public enrollment, review HAC-104, verify an internal allowlist and agree
the rollout. The proposed first public stage is 10% eligible enrollment split
50/50, with a reviewed expansion based on contribution, not traffic reduction.

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
after the actual launch; launch readiness review is September 23, 2026.

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
   configuration after QA. Keep Production disabled pending the reviewed launch.
