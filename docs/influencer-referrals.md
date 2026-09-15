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
  inferred. Users who consent later need to revisit the link. Link-open counts
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
   recording command failed.
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
   where required, then revisit the link. Sign up as a new test user and purchase
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
