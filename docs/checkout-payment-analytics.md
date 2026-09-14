# Initial subscription checkout analytics

Initial Checkout failures can occur before Stripe creates a subscription or an
invoice. The subscription webhook records these separately from invoice billing
failures. This is measurement only: it does not collect payment, change fraud
rules, grant access, or emit another paid conversion.

The required additional Stripe events on `/api/subscription/webhook` are:

- `payment_intent.payment_failed` → `checkout_payment_failed`
- `payment_intent.requires_action` → `checkout_payment_requires_action`
- `payment_intent.canceled` → `checkout_payment_canceled`
- `payment_intent.succeeded` → `checkout_payment_succeeded`
- `checkout.session.expired` → `checkout_expired`

Deploy the handler before enabling these events on the existing endpoint; preserve
all existing subscriptions. Verify sandbox and production endpoint/account and
PostHog project independently. Restricted Stripe keys need Checkout Sessions and
Charges read permissions. The signing secret and endpoint API version stay unchanged.

PaymentIntent events resolve their Checkout Session using Stripe's exact
`payment_intent` list filter. Only one matching subscription-mode session with
server-generated `checkoutType=new_subscription` and `userId` metadata is eligible.
Customer, live/test mode, and the intent's creation window must match. Renewals,
credit purchases, pause-resume checkouts, legacy sessions, and ambiguous matches
are excluded. No inference from a nearby customer payment is used.

The historical event payload supplies intent status and error codes; a charge
lookup uses only that event's charge reference. Raw messages, payment methods,
card details, emails, and arbitrary metadata are never forwarded. Replayed Stripe
event IDs produce deterministic PostHog UUIDs. These events bypass the shared
fulfillment idempotency table so another endpoint can still fulfill its payment.
Stripe lookup failures return 500 for retry. PostHog capture/flush uses the existing
best-effort logger: missing analytics is not proof that no payment was attempted.

## Conversion readout

Use distinct `stripe_checkout_session_id` values for checkout-level counts and
distinct authenticated users for user-level counts. Reopening a session can change
its `checkout_attempt_id`, source, or surface metadata; those fields are explicitly
labeled `session_metadata_at_webhook` and must not split the session into multiple
customers or attempts. Join experiment assignment from the user's original
exposure and cohort time; do not re-evaluate a flag at payment time.

Keep these separate:

1. Checkout started: a session was created or reused, not proof the hosted page loaded.
2. Payment failed or requires action: a recorded payment problem or authentication step.
3. Checkout payment succeeded: payment succeeded, not yet the entitlement conversion.
4. Paid conversion: the existing positive first-payment `subscription_started` event.

For recovery, require failure followed by success for the same session/intent,
ordered by `stripe_event_created_at`, within a declared follow-up window. A later
successful session by the same user is a separate user-level recovery measure.
Webhook ingestion order is not occurrence order. Expiry means a session expired;
it does not mean payment was never attempted. Distinguish unknown cancellation
reasons from declines. Do not label every success as a recovered failure.

Compare cohorts with equal, complete follow-up windows (for example 24 hours for
checkout completion and seven days for exposure-to-paid conversion). Count unique
sessions with a failure rather than raw failed events; card retries legitimately
produce several distinct failure events. Deduplicate invoice/subscription outcomes
using their stable Stripe IDs. Treat existing invoice fulfillment as authoritative.

## Verification

Automated webhook/helper tests cover signed-event dispatch, unrelated intents,
exact session matching, failure privacy, expiry, duplicate delivery, delayed failure
after success, session reuse, and transient Stripe lookup retries. They do not prove
the live endpoint is subscribed to the additional Stripe event types.

In Stripe sandbox after deployment, open a new subscription Checkout, submit a
documented declined test card, then complete it with a successful test card. Confirm
the failure and success share the session/customer IDs, appear in development
PostHog, and only the normal invoice handler records paid conversion. Repeat with
an authentication-required card and an expired session. Resend a failure webhook
and confirm one deduplicated event; send a renewal/credit payment and confirm it
does not enter this funnel. No real payment is needed for this verification.

After production event subscription changes, inspect naturally occurring signed
deliveries and the production PostHog events. Read back enabled event types and
confirm existing invoice deliveries still succeed. Do not generate a production
charge solely to verify telemetry.
