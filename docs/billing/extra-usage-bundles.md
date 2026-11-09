# Extra Usage bundle accounting and rollout

Personal prepaid bundles use immutable, versioned offer IDs in
`lib/billing/extra-usage-bundles.ts`. Retain old offers for delayed Stripe events.
Custom top-ups and auto-reload do not receive bundle discounts.

Checkout metadata and the purchase ledger distinguish credit face value
(`amountDollars` / `amount_dollars`) from actual cash paid (`paidAmountDollars` /
`paid_amount_dollars`). Revenue uses actual cash. Existing point conversion and
spending caps retain their face-value semantics. Never revalue existing wallets.
Both confirmation and webhook validate bundle currency, payment total, and offer
metadata before the existing atomic, session-deduplicated grant.

## Sales gate

The Convex deployment owns `EXTRA_USAGE_BUNDLES_ENABLED` (literal `true`) and an
optional comma-separated `EXTRA_USAGE_BUNDLES_USER_IDS` internal allowlist.
The frontend reads the same backend gate used by checkout. Unset values disable
new sales. Disabling sales never blocks fulfillment of already-paid sessions.
Active personal Pro, Pro+, or Ultra subscriptions are checked in Stripe before
bundle checkout. Team purchases retain their existing behavior.

Use the verified HackerAI Developer Preview deployment for the eligible Preview
population, and the separate verified HackerAI Production deployment for any
approved Production allowlist. Verify account/project/deployment identity before
configuration. These values are Convex settings, not Vercel or Trigger settings;
no Agent worker changes are required. Ship Convex before the frontend. Activate
only after Preview payment and UI acceptance. Roll back new sales by disabling
the gate and clearing the allowlist; keep fulfillment code deployed.

Actual rendered offer exposure emits `extra_usage_bundles_viewed`. Checkout
success analytics record cash paid separately from credit granted. Evaluate
repeat consumption and contribution with the remaining prepaid liability;
larger cash receipts alone are not profit evidence.

## Acceptance before activation

1. In Preview with Stripe test mode and an active personal paid QA subscription,
   open Settings > Extra Usage. Verify all three offers, mobile scrolling, credit
   value and actual payment amount. Verify the gate-off account sees no offers.
2. Buy each test bundle. Stripe must charge $45/$200/$700 and the wallet must gain
   $50/$250/$1,000 (subject to existing point rounding). Reload to verify persistence.
3. Deliver confirmation and webhook in both orders and retry each. Verify one
   grant and one cash revenue event. Reject a mismatched amount or currency.
4. Disable sales after creating a session; complete payment and verify it still
   credits. Verify custom top-ups, auto-reload, Team checkout and spending caps.
5. Publish the companion Intercom draft only when the offer becomes available:
   https://app.intercom.com/a/apps/wjc8uwt3/knowledge-hub/all-content?activeContentId=23711997&activeContentType=article&editorMode=view
