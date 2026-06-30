import { after, NextRequest, NextResponse } from "next/server";
import { stripe } from "@/app/api/stripe";
import { getConvexClient } from "@/lib/db/convex-client";
import { api } from "@/convex/_generated/api";
import { phLogger } from "@/lib/posthog/server";
import {
  PAID_FUNNEL_EVENTS,
  paidFunnelProperties,
} from "@/lib/analytics/paid-funnel";
import { logExtraUsagePurchase } from "@/lib/billing/extra-usage-purchase-logging";

const ROUTE = "/api/extra-usage/confirm" as const;

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
 * GET /api/extra-usage/confirm?session_id=cs_xxx
 *
 * Landing endpoint after Stripe Checkout completes. Verifies the session
 * directly with Stripe and credits the user's balance synchronously so they
 * see the new balance immediately on return. The async webhook at
 * /api/extra-usage/webhook remains the safety net for cases where the user
 * closes the tab before this route runs — both paths share a session-scoped
 * idempotency key (`cs_<session_id>`), so whichever commits first wins.
 */
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("session_id");
  const origin = req.nextUrl.origin;

  if (!sessionId || !sessionId.startsWith("cs_")) {
    return NextResponse.redirect(origin, { status: 303 });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.metadata?.type !== "extra_usage_purchase") {
      return NextResponse.redirect(origin, { status: 303 });
    }

    const userId = session.metadata.userId;
    const amountDollars = session.metadata.amountDollars
      ? parseFloat(session.metadata.amountDollars)
      : parseInt(session.metadata.amountCents ?? "0", 10) / 100;
    const stripeCustomerId = stripeObjectId(session.customer);
    const stripePaymentIntentId = stripeObjectId(session.payment_intent);
    const stripeInvoiceId = stripeObjectId(session.invoice);

    if (!userId || isNaN(amountDollars) || amountDollars <= 0) {
      logExtraUsagePurchase("warn", "extra_usage_purchase_invalid_metadata", {
        route: ROUTE,
        requestHeaders: req.headers,
        stripeCheckoutSessionId: session.id,
        stripePaymentIntentId,
        stripeInvoiceId,
        paymentStatus: session.payment_status,
        reason: "invalid_session_metadata",
      });
      return NextResponse.redirect(origin, { status: 303 });
    }

    logExtraUsagePurchase("info", "extra_usage_purchase_session_seen", {
      route: ROUTE,
      requestHeaders: req.headers,
      userId,
      amountDollars,
      stripeCheckoutSessionId: session.id,
      stripePaymentIntentId,
      stripeInvoiceId,
      paymentStatus: session.payment_status,
      result: "session_seen",
    });

    const redirectUrl = new URL(origin);
    redirectUrl.searchParams.set("extra-usage-purchased", "true");
    redirectUrl.searchParams.set("amount", String(amountDollars));

    // Async payment methods (e.g. bank debits) finalize later — webhook will
    // credit when Stripe sends `checkout.session.async_payment_succeeded` or
    // an eventual `checkout.session.completed` with `payment_status: paid`.
    if (session.payment_status !== "paid") {
      logExtraUsagePurchase("info", "extra_usage_purchase_payment_pending", {
        route: ROUTE,
        requestHeaders: req.headers,
        userId,
        amountDollars,
        stripeCheckoutSessionId: session.id,
        stripePaymentIntentId,
        stripeInvoiceId,
        paymentStatus: session.payment_status,
        result: "payment_pending",
      });
      redirectUrl.searchParams.set("extra-usage-pending", "true");
      return NextResponse.redirect(redirectUrl, { status: 303 });
    }

    const convex = getConvexClient();
    let result: { alreadyProcessed: boolean };
    try {
      await convex.mutation(api.extraUsage.recordPurchasePaidSeen, {
        serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
        userId,
        amountDollars,
        stripeCheckoutSessionId: session.id,
        stripePaymentIntentId,
        stripeInvoiceId,
        route: "confirm",
      });

      result = await convex.mutation(api.extraUsage.addCredits, {
        serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
        userId,
        amountDollars,
        idempotencyKey: `cs_${session.id}`,
        revenueSource: "extra_usage_purchase",
        stripeCustomerId,
        stripeCheckoutSessionId: session.id,
        stripePaymentIntentId,
        stripeInvoiceId,
        purchaseRoute: "confirm",
      });
    } catch (error) {
      try {
        await convex.mutation(api.extraUsage.recordPurchaseFailed, {
          serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
          userId,
          amountDollars,
          stripeCheckoutSessionId: session.id,
          stripePaymentIntentId,
          stripeInvoiceId,
          route: "confirm",
          lastError: errorMessage(error),
        });
      } catch (recordError) {
        logExtraUsagePurchase(
          "error",
          "extra_usage_purchase_failure_record_failed",
          {
            route: ROUTE,
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
        route: ROUTE,
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

      const fallback = new URL(origin);
      fallback.searchParams.set("extra-usage-purchased", "true");
      return NextResponse.redirect(fallback, { status: 303 });
    }

    logExtraUsagePurchase(
      "info",
      result.alreadyProcessed
        ? "extra_usage_purchase_credit_skipped"
        : "extra_usage_purchase_credit_succeeded",
      {
        route: ROUTE,
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

    try {
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
    } catch (analyticsError) {
      logExtraUsagePurchase("warn", "extra_usage_purchase_analytics_failed", {
        route: ROUTE,
        requestHeaders: req.headers,
        userId,
        amountDollars,
        stripeCheckoutSessionId: session.id,
        stripePaymentIntentId,
        stripeInvoiceId,
        paymentStatus: session.payment_status,
        result: result.alreadyProcessed ? "already_processed" : "credited",
        error: analyticsError,
      });
    }

    return NextResponse.redirect(redirectUrl, { status: 303 });
  } catch (err) {
    logExtraUsagePurchase("error", "extra_usage_purchase_confirm_failed", {
      route: ROUTE,
      requestHeaders: req.headers,
      stripeCheckoutSessionId: sessionId,
      result: "confirm_failed",
      error: err,
    });
    // Webhook is the safety net — don't block the user on confirm failures.
    const fallback = new URL(origin);
    fallback.searchParams.set("extra-usage-purchased", "true");
    return NextResponse.redirect(fallback, { status: 303 });
  }
}
