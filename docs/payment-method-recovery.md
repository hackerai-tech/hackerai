# Payment-method recovery verification

## Behavior and boundaries

An actual default payment-method change on `customer.updated` or
`customer.subscription.updated` emits `payment_method_updated`. Attaching a card
alone is not a selection. Events include the customer/subscription/invoice join
IDs, scope, and subscription status, but no card IDs, card numbers, or user content.
Count distinct affected users or subscriptions when measuring recovery; a customer
update can also produce a subscription update, so raw event counts are not unique
card updates.

For an eligible delinquent subscription, synchronize its overriding payment method
and attempt payment of its latest open automatic renewal invoice. Customer and
subscription deliveries share the invoice-payment idempotency key. Default-card
updates use selection-event-scoped keys so selecting a previous card again cannot
reuse an old update response. Declines/authentication
requirements remain pending; operational errors fail webhook delivery for retry.
Only the existing `invoice.paid` handler can restore access. No old, canceled,
scheduled-for-cancellation, paused, manual, written-off, upgrade, initial-payment,
paid, stale-invoice, or in-progress-payment case is collected by this helper.
Healthy subscriptions' defaults are not rewritten.

Before a customer event replaces a different subscription default, inspect Stripe's
subscription-update event history since that customer event. A newer card selection
or an ambiguous same-second selection preserves the subscription override. The
scan is bounded to 1,000 events and skips collection if history is incomplete or
the customer event is older than Stripe's 30-day retention. API lookup failures
retry webhook delivery. Restricted Stripe keys need Events read permission.

## Release requirements

1. Verify the intended account, deployment, custom domain, and environment before
   any configuration or deployment. Never connect a Stripe sandbox to production
   user data. Preview uses the designated HackerAI Developer Convex deployment and
   PostHog project `401167`; production uses the designated HackerAI Convex
   deployment and PostHog project `144137`.
2. Deploy the additive Convex schema/mutation change before the application handler:
   it accepts `customer.subscription.updated` as a lifecycle event.
3. On the subscription webhook destination, enable `customer.updated` while
   preserving `checkout.session.completed`, `invoice.paid`,
   `invoice.payment_failed`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `refund.created`, and `refund.updated`.
   Read back the target URL and the complete event list. Do not add
   `payment_method.attached` for recovery analytics.
4. Deploy the app and complete the sandbox journey below before claiming the
   production recovery behavior is verified. Existing tests mock Stripe, Convex,
   WorkOS, and access state; they are not a substitute for this journey.

## Manual sandbox journey (required)

Use a disposable test user, organization, and Stripe sandbox customer. Verify all
credentials and endpoints select the same test environment without printing secrets.
Do not use a real customer's card or `scripts/attach-failing-card.ts` (that script
detaches existing methods and has no sandbox guard).

1. Purchase a test subscription and confirm paid access. Make an automatic renewal
   fail using Stripe's documented test payment methods/test clock. Preserve an old
   failing subscription-level default. Verify `invoice.payment_failed`, delinquent
   status, and the corresponding access hold.
2. From HackerAI's billing recovery entry point, open the customer portal and select
   a successful test card. Confirm `payment_update_opened` followed by
   `payment_method_updated` for that test identity in Preview PostHog.
3. Read back the customer's default and subscription's default: both must select
   the replacement card. Verify the latest renewal invoice actually reaches
   `paid` with a successful Stripe payment, not just a successful card attachment.
4. Verify `invoice.paid` delivery succeeds, the subscription returns to an eligible
   paid state, and `billing_payment_recovered` is emitted. Reload HackerAI, submit
   a bounded test chat, and confirm it completes through the formerly held access
   path. Card selection alone must never restore access.
5. Replay the same customer/subscription/invoice deliveries: no second successful
   payment, no extra access reset, and no duplicate event for the same insert ID.
6. Repeat with a declining/authentication-required replacement. The account remains
   pending until actual payment succeeds; card-update telemetry still appears.
   Complete authentication through Stripe's payment flow, then verify recovery.
7. Select customer card A, then subscription card B; deliver customer A's event
   last. Verify B remains selected and A is not charged. Repeat with same-second
   timestamps, where the subscription override is conservatively preserved.
8. Check an attachment-only event, a stale default-card event, and a canceled
   subscription: none initiates collection. Remove disposable test artifacts only
   after recording sanitized outcomes and confirming their exact IDs.

Measure recovered users/invoices within a fixed window after the first renewal
failure, joining by subscription and invoice. Separate card selection, actual
payment, and restored access; do not label a card update itself a recovery.

References: [Stripe retry precedence](https://docs.stripe.com/billing/revenue-recovery/smart-retries),
[invoice payment API](https://docs.stripe.com/api/invoices/pay).
