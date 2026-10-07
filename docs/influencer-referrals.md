# Influencer referrals

Influencer links use `/r/<code>`, for example `https://hackerai.co/r/medusa`.
An operator creates each partner; influencers do not need a paid HackerAI plan.
Use their HackerAI account email when creating the partner so self-referrals
are excluded. Links are case-insensitive; codes contain 2–24 lowercase letters,
digits, or hyphens and cannot be reused.

## Attribution and terms

- A signed first-click cookie lasts 30 days, subject to the existing analytics
  consent policy. No attribution cookie is set when consent is required but
  absent, or declined. Cross-device and cookie-blocked attribution is not
  inferred. While consent is pending, the landing URL retains `?ref=<code>`
  without storing or tracking it. Accepting automatically revisits the short
  link to save attribution and return to the clean homepage; declining removes
  the parameter without tracking. Leaving the landing page before choosing can
  lose the pending code. Link-open counts
  exclude recognized bots and count visits, not unique people.
- Only accounts created after the click can qualify, with attribution captured
  within seven days of signup. Signup and checkout both attempt attribution.
  Existing billing customers, self-referrals, and recreated identities are
  excluded. The first persisted attribution wins across influencer commissions
  and the existing usage-credit referral program.
- Rates are snapshotted at attribution: defaults are 1,500 basis points (15%)
  on monthly invoices and 1,000 basis points (10%) on the first annual invoice.
  Both are limited to the first calendar year after the first positive paid
  invoice of the referred subscription. Rates can be set when creating a partner.
- Each invoice is held for exactly 30 days after Stripe's `paid_at` timestamp.
  Eligibility does not send money automatically. Operators reconcile, reserve,
  transfer externally, and record the transfer reference.
- Commission uses collected subscription revenue after discounts and excluding
  taxes. Partial refunds reduce the base proportionally, including the refunded
  tax share. Extra-usage purchases do not qualify. Credit-note refunds are not
  deducted twice; non-refund credits reduce the base too.
- Open disputes and pending refunds block payout. Lost disputes remove the
  invoice's commission. Post-payout adjustments create a negative balance for
  the next payout; the original transfer remains in the audit trail.
- Deactivation stops new attribution. It preserves existing attribution and
  obligations. Disabling a link is not a way to erase earned commissions.

## Deployment

Deploy the Convex schema/functions before the web application. This is an
operator-allowlisted acquisition channel, not a random user experiment; there
is no new PostHog feature flag or Trigger worker change. See HAC-121 for the
pilot measurement and review plan.

Verify the environment/account/project/deployment mapping in AGENTS.md before
using any service credentials. Keep Preview and Production configuration
separate. Local verification must use this worktree's own local deployment.

Configure a separate Stripe webhook endpoint at `/api/influencers/webhook`
with its own `STRIPE_INFLUENCER_WEBHOOK_SECRET`. Subscribe to:

```
invoice.paid
charge.refunded
charge.dispute.created
charge.dispute.updated
charge.dispute.closed
refund.updated
credit_note.created
credit_note.updated
credit_note.voided
```

The endpoint verifies Stripe's signature and returns 500 for reconciliation
failures so Stripe retries. It reads current Stripe state and upserts by invoice
ID; it does not share the subscription fulfillment webhook's event ledger.
The operator report also backfills paid invoices, so a missed webhook is
recovered before payout. A new webhook secret requires a web redeployment.

Existing environment requirements: `NEXT_PUBLIC_CONVEX_URL`,
`CONVEX_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`, `NEXT_PUBLIC_BASE_URL`,
`ACCOUNT_IDENTITY_HMAC_SECRET`, and `WORKOS_COOKIE_PASSWORD`.
Stripe Tax configuration remains unchanged; commissions use invoice tax totals.

## Operator workflow

Use `scripts/influencers.ts` from the verified checkout with environment values
already loaded, or Node's `--env-file` for that checkout. Credentials stay in the
environment; do not put them in JSON or command arguments.

```sh
node --env-file=.env.local --import tsx scripts/influencers.ts < partner-request.json
```

Every request must contain `targetUrl`, `stripeAccountId`, and `live`, matching
the independently verified Convex URL, Stripe account, and Stripe mode. The
script checks these before writing. Requests are strict JSON. Store request
and report files privately outside version control (for example `.artifacts/`).

Create a partner through the verified web deployment. Set `NEXT_PUBLIC_BASE_URL`
to that deployment's verified origin and load its matching `NEXT_PUBLIC_CONVEX_URL`
and `CONVEX_SERVICE_ROLE_KEY`. Creation calls the service-authenticated
`/api/internal/influencers/partners` endpoint, where the Stripe account/mode and
Convex target are checked before writing. The web runtime computes the owner
identity using its existing `ACCOUNT_IDENTITY_HMAC_SECRET`; do not export or copy
that secret to an operator machine. Creation does not require a local Stripe key;
other operator actions still do.

Retrying creation with the same normalized details returns the same link. An
existing code with different details or an inactive partner returns a conflict;
creation never overwrites a partner or reactivates it. Use `activate` explicitly.
Deploy the web endpoint before using the updated creation command.

Create a partner:

```json
{
  "targetUrl": "https://VERIFIED-DEPLOYMENT.convex.cloud",
  "stripeAccountId": "acct_VERIFIED_ACCOUNT",
  "live": false,
  "action": "create",
  "code": "medusa",
  "name": "Medusa",
  "email": "influencer-account@example.com",
  "monthlyBps": 1500,
  "annualBps": 1000
}
```

Keep the three target fields in each subsequent request:

1. `{"action":"report","code":"medusa","output":".artifacts/medusa.json"}`
   reconciles Stripe and exports consented link opens, signup count, paying customers, invoice/customer/
   subscription IDs, gross/net revenue, rates, earned/paid balances, eligibility
   dates, and review states. Output files are created with mode 0600 and are not
   overwritten. Reports contain private financial identifiers; do not send the
   raw export to influencers.
2. `{"action":"reserve","code":"medusa","key":"medusa-2026-10-01"}`
   reconciles again and atomically reserves the eligible net USD balance,
   including old clawbacks. Use a unique key for each payout. Retrying the same
   key returns the same payout. Only one open reservation per partner is allowed.
3. Check the external payment provider for that key, then transfer the exact
   reserved amount once. The script never moves money. Complete this promptly;
   if a reservation is stale and no money was sent, cancel it and reserve again.
4. `{"action":"paid","key":"medusa-2026-10-01","reference":"provider-transfer-id"}`
   records the completed external payment. Retry with the same key and reference
   if the result is uncertain. Never issue another transfer merely because the
   recording command failed. Use a provider-qualified reference (for example
   `paypal:transfer-123`); the same external transfer cannot settle two payouts.
5. `{"action":"payout","key":"medusa-2026-10-01"}` reads the immutable batch
   amount, included invoices, status, and recorded transfer reference.

Use `cancel` with a payout `key` only after confirming no transfer was sent.
Use `activate` or `deactivate` with a partner `code` to manage new attribution.
There is no bank-account storage or influencer-facing portal in this version.

## Review conditions and limits

The pilot pays USD only. Unsupported currencies, mixed/non-subscription invoice
lines, shared-charge allocations, off-Stripe payments, missing tax information,
and pending payment adjustments are held for review; operators cannot silently
override them into payable money. Reconcile after resolving the underlying
Stripe condition. If the billing structure itself is unsupported, extend and
test the calculation before payout.

Payout preparation fails closed above 1,000 invoices per partner or when any
invoice reconciliation is older than five minutes. Reporting is paginated.
Increase capacity through a paginated reconciliation/balance design before
expanding beyond the pilot; never pay a partial scan that can omit clawbacks.

Only service-key-authenticated callers can read/write partner or financial
records. Customer identity uses the existing email HMAC; subscriber emails,
payment credentials, prompts, and chat content are not copied into the ledger.
Financial references and pseudonymous attribution remain for reconciliation
after account deletion, so recreating an account cannot reset attribution.

## Manual acceptance

In the verified Preview environment with Stripe test mode:

1. Create a disposable partner, open its short link, accept analytics consent
   where required, and confirm the URL clears automatically. Sign up as a new test user and purchase
   a monthly plan. Confirm one attribution and one holding invoice in the report.
2. Reload, retry checkout, and replay the payment webhook. Confirm no duplicate
   attribution or commission. Existing accounts and self-referrals must not earn.
3. Refund part/all of the test payment and replay the adjustment event. Confirm
   the net commission decreases. Exercise a test dispute and verify payout is
   held; after a loss it becomes zero.
4. Verify the 30-day hold boundary with the automated ledger tests. For a real
   pilot invoice, confirm `reserve` rejects it before its eligibility timestamp.
   Record a disposable test payout only after it is eligible; retry the same key
   and reference and confirm the paid balance changes once.
5. Confirm the short link works through the actual Preview URL. Repeat the
   non-payment checks on `hackerai.co` only after an authorized production rollout.

## PostHog analytics

The influencer funnel is separate; the existing `referred_*` events
belong to the usage-credit program. Filter the **Influencer referrals** dashboard
by the event property `influencer_code`. Preview/development uses the
[development dashboard](https://us.posthog.com/project/401167/dashboard/2108269);
Production uses the [production dashboard](https://us.posthog.com/project/144137/dashboard/2108283).
Never send QA fixtures to Production.

A signed random browser visitor ID connects link visits, attributed signup,
checkout creation, and first payment. It survives clearing the attribution
cookie after signup. Repeated visits count separately; unique visitors count
once per browser ID. Cookies last 30 days. Browsers/devices, expired cookies,
blocked cookies, and missing consent cannot be joined or inferred. Existing
legacy attribution cookies still work for commissions, but have no visitor ID
and are excluded from this new analytics series. Historical traffic is not
backfilled. Signup events mean eligible attributed signups, not every account
that opened a link. The ordered funnel uses the same influencer at every step
and a 30-day visit-to-payment window; recent cohorts are still incomplete.

Consent denial prevents visitor cookies and link events. Withdrawal through
privacy settings clears influencer cookies, records an opt-out for signed
visitor IDs and the signed-in account’s persisted attribution (including expired
cookies), suppresses their pending events, and stops future financial
analytics for those IDs. It does not erase delivered historical events or the
commission ledger. An event already in flight may finish delivery. A database
failure during withdrawal is surfaced so the user can retry before the signed
visitor cookie is removed.

Financial transitions and signup attribution enqueue events in the same Convex
transaction. Delivery runs after HTTP responses; the authenticated
`/api/cron/influencer-analytics` job retries up to 500 queued events each minute
in Production. Preview has immediate delivery but Vercel does not run Preview
crons; invoke the authenticated endpoint or run an operator report to retry.
Capture failures leave events pending and do not prevent payments or payouts.
Original timestamps and stable UUIDs survive retries. PostHog deduplication is
eventual, so revenue tables also deduplicate UUIDs before summing signed deltas.
Stripe's second-resolution payment time is clamped just after checkout for the
first-payment funnel event when both happen in the same second; the invoice
ledger retains the original Stripe payment time.

Use PostHog's Activity view for automatically refreshing incoming events.
Dashboards require refresh and are subject to ingestion and query caching;
this is near-real-time measurement, not an instantaneous or authoritative
payout balance. Set `INFLUENCER_ANALYTICS_DISABLED=true` in the relevant web
runtime to pause delivery without discarding the queue. This uses the web
runtime's existing PostHog write key/host and service key; no Trigger worker
configuration is involved. The cron uses the existing `CRON_SECRET`.

Revenue and commission charts sum deltas: first invoice observations add the
current amounts; refunds, credits, and later reconciliation adjust them.
First-payment conversions remain conversions after a refund; review the
adjustment and net-revenue charts alongside the funnel. Renewals are paid
invoices whose Stripe invoice ID differs from the subscription's first positive
paid invoice. Review reasons highlight unsupported payments and open disputes.
The existing ledger's revenue basis is collected subscription revenue after
discounts/tax/refunds/credits, not accounting profit or a chargeback settlement
report. Use Stripe to reconcile dispute losses. Currency-specific money must
never be summed together; the dashboard economics table is USD only.

Record a partner's **cumulative USD sponsorship spend**, rather than adding the
same fee each time, using the usual verified target fields:

```json
{ "action": "cost", "code": "example", "amountCents": 65000 }
```

This records $650 of total spend; repeating it changes nothing. A later
correction emits only the difference. No money is transferred. The operator
report includes the saved spend. Dashboard contribution subtracts commissions
and recorded sponsorship spend from revenue; it excludes payment processing,
model/sandbox costs, and dispute settlements, so must not be called profit.
Period acquisition spend per new payer includes renewal commissions and the
period in which spend was recorded; it is not a matched acquisition-cohort CAC.

Only allowlisted event properties are exported: partner code, random visitor
ID, plan/interval, currency, monetary deltas, review status and elapsed time.
Contact emails, identity HMACs, raw Stripe IDs, prompts, targets, findings and
payment credentials are not sent. Person profiles and GeoIP enrichment are
disabled for these events. Delivered queue rows are pruned in bounded batches
after 90 days; invoice revisions and attribution records prevent replay from
recreating financial/signup transitions.
