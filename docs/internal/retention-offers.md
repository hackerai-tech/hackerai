# Retention offer: pause subscription

The pause offer appears inside the in-app cancellation dialog after the user
has answered the cancellation survey. It is gated by the PostHog feature flag
`hac-96-pause-subscription-offer` and fails closed to the plain cancel flow.

## What the user sees

1. Reason and follow-up survey (unchanged).
2. **Before you cancel** step with a **Pause your plan** card (1, 2, or 3
   months) and a "No thanks, continue to cancel" link to the existing
   confirmation step.
3. Account settings shows **Pause scheduled** with **Cancel pause** until the
   paid-through date, and **Your plan is paused / Resume now** afterwards.

Eligibility lives in `lib/billing/retention-offers.ts`: Pro, Pro+, or Ultra;
monthly; single seat; subscription `active` or `trialing`; no cancellation
already scheduled; reason is too expensive, not using enough, hit usage
limits, temporary pause, or other; no pause requested in the last 180 days.

## How a pause works

Stripe's native pause endpoint is preview-only and `pause_collection` keeps the
subscription (and therefore WorkOS entitlements and usage refills) active, so a
pause is modelled as a scheduled cancellation plus an automatic resume:

1. `POST /api/billing/pause` schedules `cancel_at_period_end`, writes pause
   metadata (`hackeraiPause*`) on the Stripe subscription, and inserts a
   `subscription_pauses` row (`scheduled`).
2. The subscription stays fully usable until the paid-through date.
3. `customer.subscription.deleted` marks the row `paused`; the user drops to
   the free tier through the normal WorkOS entitlement sync.
4. The hourly Vercel cron `/api/cron/subscription-pauses` re-creates the
   subscription with the same price and the saved payment method on
   `resume_at`. The Convex claim (`claimResume`) is atomic, so overlapping runs
   and the "Resume now" button cannot double-bill.
5. The resulting `invoice.paid` (`subscription_create`, metadata
   `checkoutType=pause_resume`) refills usage credits and is reported as a
   reactivation, not a new paid start.

Failure handling:

- Card declined on the automatic path: retried daily, up to 3 attempts, then
  `resume_failed`. Account settings shows "Resume now" so the user can retry
  after updating their card.
- No saved payment method: `resume_failed` immediately; the user is pointed to
  the pricing page.
- The customer already has a live subscription: the pause is `superseded`.

Users can cancel a scheduled pause with the existing **Keep plan** action
(shown as **Cancel pause**), which also clears the Stripe metadata.

## Analytics

Events (all carry `paid_funnel_event_version`):

- `retention_offer_impressed` (client, exposure) with `offers_shown`
- `retention_offer_accepted` / `retention_offer_declined`
- `subscription_pause_scheduled`, `subscription_pause_canceled`,
  `subscription_pause_resumed`, `subscription_pause_resume_failed`
- Existing `cancellation_completed` and `subscription_cancelled` gain
  `retention_pause=true` when the cancellation is a pause.
- `subscription_started` gets `conversion_type=pause_resume` and zeroed
  paid-start counters on resume.

The Convex cancellation report now includes `pausedCount` per reason group.

## Environment

- `PAUSE_OFFER_ENABLED=true|false` overrides the PostHog flag (local dev or
  kill switch). Leave unset in production.
- `CRON_SECRET` protects the resume cron, like the existing platform-cost crons.
- The Convex schema adds the `subscription_pauses` table; deploy Convex before
  enabling the flag.
