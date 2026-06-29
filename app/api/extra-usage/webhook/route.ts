import { after, NextRequest, NextResponse } from "next/server";
import { stripe } from "@/app/api/stripe";
import { getConvexClient } from "@/lib/db/convex-client";
import { api } from "@/convex/_generated/api";
import Stripe from "stripe";
import { phLogger } from "@/lib/posthog/server";
import {
  PAID_FUNNEL_EVENTS,
  paidFunnelProperties,
} from "@/lib/analytics/paid-funnel";
import {
  logStripeWebhookMissingSignature,
  logStripeWebhookSignatureVerificationFailed,
} from "@/lib/billing/stripe-webhook-logging";
import { logExtraUsagePurchase } from "@/lib/billing/extra-usage-purchase-logging";

const WEBHOOK_LOG_PREFIX = "[Extra Usage Webhook]";
const WEBHOOK_LOG_CONTEXT = {
  webhook: "extra_usage",
  route: "/api/extra-usage/webhook",
} as const;

function stripeObjectId(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id?: unknown }).id;
    return typeof id === "string" ? id : undefined;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * POST /api/extra-usage/webhook
 * Handles Stripe webhook events for extra usage purchases.
 *
 * Configure this webhook in Stripe Dashboard:
 * - Endpoint URL: https://your-domain.com/api/extra-usage/webhook
 * - Events to listen: checkout.session.completed,
 *   checkout.session.async_payment_succeeded
 */
export async function POST(req: NextRequest) {
  const body = await req.text();
  const signature = req.headers.get("stripe-signature");

  if (!signature) {
    logStripeWebhookMissingSignature({
      logPrefix: WEBHOOK_LOG_PREFIX,
      ...WEBHOOK_LOG_CONTEXT,
      requestHeaders: req.headers,
      body,
      signature,
    });
    return NextResponse.json(
      { error: "Missing stripe-signature header" },
      { status: 400 },
    );
  }

  const webhookSecret = process.env.STRIPE_EXTRA_USAGE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error(
      "[Extra Usage Webhook] STRIPE_EXTRA_USAGE_WEBHOOK_SECRET is not configured",
    );
    return NextResponse.json(
      { error: "Webhook secret not configured" },
      { status: 500 },
    );
  }

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch (err) {
    logStripeWebhookSignatureVerificationFailed({
      logPrefix: WEBHOOK_LOG_PREFIX,
      ...WEBHOOK_LOG_CONTEXT,
      requestHeaders: req.headers,
      body,
      signature,
      error: err,
    });
    return NextResponse.json(
      { error: "Webhook signature verification failed" },
      { status: 400 },
    );
  }

  // Handle the event
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const session = event.data.object as Stripe.Checkout.Session;
      // Only process extra usage purchases
      if (session.metadata?.type !== "extra_usage_purchase") {
        return NextResponse.json({ received: true });
      }

      const userId = session.metadata.userId;
      // Support both new (amountDollars) and old (amountCents) metadata formats
      const amountDollars = session.metadata.amountDollars
        ? parseFloat(session.metadata.amountDollars)
        : parseInt(session.metadata.amountCents, 10) / 100;
      const stripeCustomerId = stripeObjectId(session.customer);
      const stripePaymentIntentId = stripeObjectId(session.payment_intent);
      const stripeInvoiceId = stripeObjectId(session.invoice);

      if (!userId || isNaN(amountDollars) || amountDollars <= 0) {
        logExtraUsagePurchase("warn", "extra_usage_purchase_invalid_metadata", {
          route: WEBHOOK_LOG_CONTEXT.route,
          requestHeaders: req.headers,
          stripeCheckoutSessionId: session.id,
          stripePaymentIntentId,
          stripeInvoiceId,
          paymentStatus: session.payment_status,
          reason: "invalid_session_metadata",
        });
        return NextResponse.json(
          { error: "Invalid session metadata" },
          { status: 400 },
        );
      }

      logExtraUsagePurchase("info", "extra_usage_purchase_session_seen", {
        route: WEBHOOK_LOG_CONTEXT.route,
        requestHeaders: req.headers,
        userId,
        amountDollars,
        stripeCheckoutSessionId: session.id,
        stripePaymentIntentId,
        stripeInvoiceId,
        paymentStatus: session.payment_status,
        result: "session_seen",
      });

      if (session.payment_status !== "paid") {
        logExtraUsagePurchase("info", "extra_usage_purchase_payment_pending", {
          route: WEBHOOK_LOG_CONTEXT.route,
          requestHeaders: req.headers,
          userId,
          amountDollars,
          stripeCheckoutSessionId: session.id,
          stripePaymentIntentId,
          stripeInvoiceId,
          paymentStatus: session.payment_status,
          result: "payment_pending",
        });
        return NextResponse.json({ received: true });
      }

      // Add credits to user's balance. Idempotency key is scoped to the Checkout
      // Session so this path and the post-checkout confirm redirect (which uses
      // the same key) can race without double-crediting.
      const convex = getConvexClient();
      try {
        await convex.mutation(api.extraUsage.recordPurchasePaidSeen, {
          serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
          userId,
          amountDollars,
          stripeCheckoutSessionId: session.id,
          stripePaymentIntentId,
          stripeInvoiceId,
          route: "webhook",
        });

        const result = await convex.mutation(api.extraUsage.addCredits, {
          serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
          userId,
          amountDollars,
          idempotencyKey: `cs_${session.id}`,
          legacyIdempotencyKey: event.id, // Guards retries of pre-deploy webhooks that stored `evt_<id>`
          revenueSource: "extra_usage_purchase",
          stripeCustomerId,
          stripeCheckoutSessionId: session.id,
          stripePaymentIntentId,
          stripeInvoiceId,
          purchaseRoute: "webhook",
        });

        logExtraUsagePurchase(
          "info",
          result.alreadyProcessed
            ? "extra_usage_purchase_credit_skipped"
            : "extra_usage_purchase_credit_succeeded",
          {
            route: WEBHOOK_LOG_CONTEXT.route,
            requestHeaders: req.headers,
            userId,
            amountDollars,
            stripeCheckoutSessionId: session.id,
            stripePaymentIntentId,
            stripeInvoiceId,
            paymentStatus: session.payment_status,
            result: result.alreadyProcessed ? "already_processed" : "credited",
          },
        );
        phLogger.event(
          PAID_FUNNEL_EVENTS.addCreditCheckoutSucceeded,
          paidFunnelProperties({
            userId,
            checkout_attempt_id: session.metadata.checkoutAttemptId,
            checkout_type: "extra_usage_purchase",
            amount_dollars: amountDollars,
            stripe_customer_id: stripeCustomerId,
            stripe_checkout_session_id: session.id,
            stripe_payment_intent_id: stripePaymentIntentId,
            payment_status: session.payment_status,
            $insert_id: `${PAID_FUNNEL_EVENTS.addCreditCheckoutSucceeded}:${session.id}`,
          }),
        );
        after(() => phLogger.flush());
      } catch (error) {
        try {
          await convex.mutation(api.extraUsage.recordPurchaseFailed, {
            serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
            userId,
            amountDollars,
            stripeCheckoutSessionId: session.id,
            stripePaymentIntentId,
            stripeInvoiceId,
            route: "webhook",
            lastError: errorMessage(error),
          });
        } catch (recordError) {
          logExtraUsagePurchase(
            "error",
            "extra_usage_purchase_failure_record_failed",
            {
              route: WEBHOOK_LOG_CONTEXT.route,
              requestHeaders: req.headers,
              userId,
              amountDollars,
              stripeCheckoutSessionId: session.id,
              stripePaymentIntentId,
              stripeInvoiceId,
              paymentStatus: session.payment_status,
              result: "failure_record_failed",
              error: recordError,
            },
          );
        }

        logExtraUsagePurchase("error", "extra_usage_purchase_credit_failed", {
          route: WEBHOOK_LOG_CONTEXT.route,
          requestHeaders: req.headers,
          userId,
          amountDollars,
          stripeCheckoutSessionId: session.id,
          stripePaymentIntentId,
          stripeInvoiceId,
          paymentStatus: session.payment_status,
          result: "failed",
          error,
        });
        // Return 500 so Stripe retries
        return NextResponse.json(
          { error: "Failed to add credits" },
          { status: 500 },
        );
      }

      break;
    }
  }

  return NextResponse.json({ received: true });
}
