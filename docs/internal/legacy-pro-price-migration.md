# Legacy Pro $20 to $29 renewal migration

This is an operator workflow for HAC-223, not an automatic rollout. Merging or
deploying does not enroll subscribers, send notices, or alter Stripe. Only the
explicit manifest allowlist can be scheduled. Do not include $25 subscribers,
annual plans, PentestGPT subscriptions, or other products.

## Notice and enrollment

Give each customer at least 30 full days of advance notice, stating the exact
UTC effective renewal date, $20 old price, $29 new price, and how to cancel in
Account settings before that date. Respect any longer notice or consent
commitment applicable to that subscription. Keep the delivery receipt privately;
provider acceptance alone is not confirmed delivery. Do not populate receipts
from an export timestamp or assume that a draft was sent.

The new price is the existing Pro $29 price (`pro-monthly-plan-29-experiment`).
The current implementation also moves the subscriber from the legacy 200,000
included usage points ($20) to standard Pro's 250,000 points ($25). This comes
from the existing price-specific allowance mapping and paid-invoice webhook;
it is not an immediate credit grant. Explain this allowance improvement in the
notice. Model the added serving costs before treating the revenue increase as
profit. This workflow does not change new-signup pricing or the pricing experiment.

For each reviewed subscriber choose the first suitable monthly renewal at least
30 days after confirmed notification. If the next renewal is too soon, retain
$20 for that renewal and switch at a later one. The script requires at least
48 hours before cutover and accepts only the current period end or the next
three monthly boundaries. UTC month-end anchors clamp for February and return
to the original anchor day. Custom anchors, historical trial metadata, discounts,
tax, credit balances, pauses, pending changes and existing schedules require
manual review and are excluded rather than overwritten.

Example private manifest (timestamps are illustrative, not a live cohort):

```json
{
  "accountId": "acct_EXAMPLE",
  "livemode": false,
  "sourcePriceId": "price_EXAMPLE20",
  "targetPriceId": "price_EXAMPLE29",
  "entries": [
    {
      "subscriptionId": "sub_EXAMPLE",
      "notifiedAt": 1800000000,
      "effectiveAt": 1805270400,
      "noticeReceipt": "delivery-provider-event-reference"
    }
  ]
}
```

Keep manifests and receipt directories outside git, private and durable. Up to
10 subscriptions per manifest; start with one test subscription. The live source
is pinned to the HackerAI legacy Pro price in `included-usage.ts`. The source and
target must be monthly USD $20/$29, licensed single-seat prices on the same
product with matching tax treatment. Target must be active. No catalog writes.

Use an explicitly provided environment key from the intended account. The CLI
does not load `.env.local`, select a key, or switch environments for you. Prefer
a restricted key with just the required account/customer/price/subscription
reads and subscription-schedule writes. Never put keys in command arguments.
Account ID, mode, source and target are checked before any writes. The script
uses the installed SDK's API version, `2026-08-26.dahlia`.

```sh
corepack pnpm exec tsx scripts/migrate-legacy-pro.ts /private/path/manifest.json
# After notice delivery, sandbox verification and separate live enrollment approval:
# STRIPE_SECRET_KEY is already supplied through a protected environment.
export LEGACY_PRO_MIGRATION_RECEIPTS_DIR=/private/persistent/migration-receipts
corepack pnpm exec tsx scripts/migrate-legacy-pro.ts /private/path/manifest.json --apply
```

Dry-run is read-only. Apply rechecks every subscription and customer, persists
an exclusive attempt file before the first write, creates a schedule from the
subscription, then configures $20 through the notified renewal and $29 for one
monthly phase, followed by release to ordinary $29 renewals. Proration is off
both on the update and phase transitions. The current item and paid-through
period must remain unchanged after scheduling. Schedules are read back before
continuing. Metadata records migration, notice and effective times without
customer content; raw delivery references stay in private receipts.

## Reconciliation and rollback

Use a single operator and the same receipt directory for every execution.
Do not run concurrently with other billing administration. Stripe does not
provide a compare-and-swap transaction across customer actions and both schedule
writes. If cancellation, pause or an upgrade races enrollment, stop and inspect
both subscription and schedule. Existing authenticated billing actions release
schedules first; those actions remain authoritative.

A timeout or failed read-back halts the batch. Do not remove attempt files,
rerun with a fresh directory, or retry after Stripe's idempotency window expires.
The receipt can say `attempting` even when Stripe committed the change. Read the
subscription's attached schedule and Stripe request logs to establish whether
creation/configuration committed. A one-phase schedule may mean create succeeded
and configure did not. Reconcile it manually before any further work. Nothing is
automatically released on an error because a successful but unacknowledged write
must not be undone blindly. Existing successful rows are not replayed.

To stop a verified pending migration, release its schedule in Stripe before the
new phase starts, then read back the old subscription price and unchanged period.
Use **release**, never cancel the schedule (which can cancel the subscription).
If cutover already happened, releasing preserves $29: it does not restore $20
or refund anything. Repricing/refunds then require separately reviewed actions.
The existing Account settings “Keep current plan” action can release a pending
schedule too. Do not automatically re-enroll customers after release.

## Acceptance and readout

Before live enrollment, verify in the approved Stripe development sandbox:

1. Create disposable monthly $20/$29 Pro prices, customer, card and test clock.
2. Schedule after a simulated delivered notice. Confirm there is no immediate
   charge and the current price, renewal anchor and paid period are unchanged.
3. Advance through a grace renewal: invoice is paid for $20. Advance through the
   notified boundary: invoice is paid for $29 without prorations. Advance again:
   another $29 invoice and schedule released.
4. On another subscription release before cutover; future invoices stay $20.
   Exercise normal cancellation, pause and upgrade through the app; each must
   release the schedule and honor the customer's selected action.
5. With a disposable QA identity linked to the sandbox customer, verify paid
   invoice webhook delivery, Pro access, standard allowance only after payment,
   displayed pending price/date, and cancellation from Account settings.
6. Interrupt after schedule creation or simulate a timeout. Confirm batch stop,
   retained attempt receipt, no automatic release/replay, and read-only diagnosis.

Steps involving the app, its identity provider and webhooks need the approved
Preview setup; direct Stripe success alone does not prove app acceptance.
Record PASS/FAIL/BLOCKED separately in the PR. Never use live customers for tests.

Freeze the baseline cohort at notice delivery and retain cancellations before
renewal in the denominator. Compare collected contribution over two renewal
opportunities plus seven days for recovery, not just invoice success among
attempts. Separate notice delivery, schedule creation, price cutover and successful
$29 payment. Review refunds, voluntary cancellations, payment failures/recovery,
support complaints and allowance regressions. Stop enrollment on incorrect
charge/date/identity/entitlement. Retire the operator tool after settlement and
the readout; retain private financial receipts.
