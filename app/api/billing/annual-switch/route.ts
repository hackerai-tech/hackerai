import { after, NextRequest, NextResponse } from "next/server";
import { stripe } from "@/app/api/stripe";
import { getBillingActionContext } from "@/lib/actions/billing-context";
import { assertUserCanStartBillingTransaction } from "@/lib/suspensions";
import { billingRouteErrorResponse } from "@/lib/billing/api-response";
import {
  annualSwitchTier,
  type AnnualSwitchQuote,
} from "@/lib/billing/annual-switch";
import { PRICING } from "@/lib/pricing/config";
import { phLogger } from "@/lib/posthog/server";
import {
  PAID_FUNNEL_EVENTS,
  paidFunnelProperties,
  normalizeCheckoutAttemptId,
} from "@/lib/analytics/paid-funnel";

export const dynamic = "force-dynamic";
const conflict = (error: string) =>
  NextResponse.json({ error }, { status: 409 });

export async function POST(request: NextRequest) {
  try {
    const context = await getBillingActionContext();
    await assertUserCanStartBillingTransaction(context.user.id);
    const body = await request.json();
    const confirming = body.confirm === true;
    const attemptId = normalizeCheckoutAttemptId(body.checkoutAttemptId);
    if (!attemptId)
      return NextResponse.json(
        { error: "Invalid checkout attempt" },
        { status: 400 },
      );
    const [customer, subscriptions] = await Promise.all([
      stripe.customers.retrieve(context.stripeCustomerId),
      stripe.subscriptions.list({
        customer: context.stripeCustomerId,
        status: "all",
        limit: 10,
        expand: ["data.latest_invoice"],
      }),
    ]);
    if (customer.deleted || customer.metadata.blocked === "true") {
      return NextResponse.json(
        { error: "This billing account cannot change plans." },
        { status: 403 },
      );
    }
    // Include incomplete/paused subscriptions in ambiguity checks, too.
    const current = subscriptions.data.filter(
      (s) => s.status !== "canceled" && s.status !== "incomplete_expired",
    );
    const subscription = current[0];
    const tier = subscription && annualSwitchTier(subscription);
    if (subscriptions.has_more || current.length !== 1 || !tier) {
      return conflict(
        "Annual switching is unavailable for this subscription. Review billing and any pending changes first.",
      );
    }
    const item = subscription.items.data[0];
    const plan = `${tier}-yearly-plan`;
    if (body.plan !== plan)
      return conflict(
        "Your plan changed. Close this dialog and review your subscription again.",
      );
    const prices = await stripe.prices.list({
      lookup_keys: [plan],
      active: true,
      limit: 2,
    });
    const price = prices.data[0];
    if (
      prices.has_more ||
      prices.data.length !== 1 ||
      !price ||
      price.currency !== "usd" ||
      price.type !== "recurring" ||
      price.billing_scheme !== "per_unit" ||
      price.recurring?.interval !== "year" ||
      price.recurring.interval_count !== 1 ||
      price.recurring.usage_type !== "licensed" ||
      price.unit_amount !== PRICING[tier].yearly * 12 * 100
    ) {
      return NextResponse.json(
        { error: "The annual price is unavailable. Please try again later." },
        { status: 503 },
      );
    }
    const now = Math.floor(Date.now() / 1000);
    const previous: AnnualSwitchQuote | undefined = body.quote;
    const prorationDate = confirming ? previous?.prorationDate : now;
    if (
      typeof prorationDate !== "number" ||
      !Number.isInteger(prorationDate) ||
      prorationDate > now ||
      prorationDate < now - 600 ||
      prorationDate < item.current_period_start
    ) {
      return conflict(
        "This quote has expired. Close and reopen this dialog for a fresh quote.",
      );
    }
    const items = [{ id: item.id, price: price.id, quantity: 1 }];
    // No estimated fallback: tax, discounts and balance must come from Stripe.
    const preview = await stripe.invoices.createPreview({
      customer: context.stripeCustomerId,
      subscription: subscription.id,
      subscription_details: {
        items,
        proration_behavior: "always_invoice",
        proration_date: prorationDate,
      },
    });
    const quote: AnnualSwitchQuote = {
      subscriptionId: subscription.id,
      currentPriceId: item.price.id,
      targetPriceId: price.id,
      prorationDate,
      amountDue: preview.amount_due,
      currency: preview.currency,
    };
    if (confirming) {
      if (
        !previous ||
        Object.keys(quote).some(
          (key) =>
            quote[key as keyof AnnualSwitchQuote] !==
            previous[key as keyof AnnualSwitchQuote],
        )
      ) {
        return conflict(
          "Your billing quote changed. Close and reopen this dialog to review the new amount.",
        );
      }
      phLogger.event(
        PAID_FUNNEL_EVENTS.checkoutStarted,
        paidFunnelProperties({
          userId: context.user.id,
          org_id: context.organizationId,
          checkout_attempt_id: attemptId,
          checkout_type: "subscription_change",
          source: "annual_switch",
          from_tier: tier,
          to_tier: tier,
          plan,
          billing_interval: "year",
          billing_interval_count: 1,
          quantity: 1,
          checkout_amount_dollars: preview.amount_due / 100,
          currency: preview.currency,
          stripe_customer_id: context.stripeCustomerId,
          stripe_subscription_id: subscription.id,
          stripe_price_id: price.id,
          $insert_id: `annual-switch-started:${attemptId}`,
        }),
      );
      after(() => phLogger.flush());
      const updated = await stripe.subscriptions.update(
        subscription.id,
        {
          items,
          proration_behavior: "always_invoice",
          proration_date: prorationDate,
          payment_behavior: "pending_if_incomplete",
          metadata: {
            ...subscription.metadata,
            checkoutAttemptId: attemptId,
            checkoutType: "subscription_change",
            checkoutSource: "annual_switch",
          },
        },
        { idempotencyKey: `annual-switch:${subscription.id}:${attemptId}` },
      );
      const invoiceId =
        typeof updated.latest_invoice === "string"
          ? updated.latest_invoice
          : updated.latest_invoice?.id;
      const invoice = invoiceId
        ? await stripe.invoices.retrieve(invoiceId)
        : null;
      if (
        invoice?.status === "paid" &&
        !updated.pending_update &&
        updated.items.data[0]?.price.id === price.id
      ) {
        return NextResponse.json({ success: true });
      }
      const invoiceUrl = invoice?.hosted_invoice_url;
      if (
        invoiceUrl &&
        new URL(invoiceUrl).origin === "https://invoice.stripe.com"
      ) {
        return NextResponse.json({ requiresPayment: true, invoiceUrl });
      }
      return conflict(
        "The change is awaiting payment confirmation. Review billing before trying again.",
      );
    }
    return NextResponse.json({
      quote,
      currentPlan: tier,
      quantity: 1,
      paymentMethod: "",
      proratedAmount:
        preview.lines.data
          .filter((l) => l.amount > 0)
          .reduce((n, l) => n + l.amount, 0) / 100,
      proratedCredit:
        -preview.lines.data
          .filter((l) => l.amount < 0)
          .reduce((n, l) => n + l.amount, 0) / 100,
      totalDue: Math.max(0, preview.amount_due) / 100,
      annualAmount: price.unit_amount / 100,
      billingIntervalChanged: true,
      currentPeriodStart: item.current_period_start,
      currentPeriodEnd: item.current_period_end,
    });
  } catch (error) {
    return billingRouteErrorResponse(error);
  }
}
