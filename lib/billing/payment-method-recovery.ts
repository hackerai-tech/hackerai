import Stripe from "stripe";
import {
  invoiceSubscriptionId,
  stripeObjectId,
} from "./subscription-payment-failure";

const PAYMENT_METHOD_RECOVERY_STEPS = [
  "retrieve_customer",
  "resolve_customer_users",
  "check_user_suspensions",
  "list_subscriptions",
  "resolve_subscription",
  "emit_payment_method_updated",
  "retrieve_invoice",
  "record_involuntary_churn_event",
  "recover_subscription_payment",
  "check_subscription_default_history",
  "update_subscription_default",
  "pay_invoice",
] as const;

/**
 * Last entered default-card recovery boundary only. It does not mean that
 * boundary's request or write committed, or that it caused the failure.
 */
export type PaymentMethodRecoveryStep =
  (typeof PAYMENT_METHOD_RECOVERY_STEPS)[number];

/** Request-local, optional failure location; never shared between deliveries. */
export type PaymentMethodRecoveryDiagnostic = {
  step?: PaymentMethodRecoveryStep;
};

const recoveryStepSet: ReadonlySet<unknown> = new Set(
  PAYMENT_METHOD_RECOVERY_STEPS,
);

/** Record a step without letting optional telemetry interrupt billing work. */
export function markPaymentMethodRecoveryStep(
  diagnostic: PaymentMethodRecoveryDiagnostic | undefined,
  step: PaymentMethodRecoveryStep,
): void {
  if (!diagnostic) return;
  try {
    diagnostic.step = step;
  } catch {
    // A frozen or hostile diagnostic must not change the financial outcome.
  }
}

/** Closed failure-context fields; an unreadable or unknown step drops the pair. */
export function paymentMethodRecoveryFailureFields(
  diagnostic: PaymentMethodRecoveryDiagnostic | undefined,
):
  | {
      payment_method_recovery_diagnostic_version: 1;
      payment_method_recovery_step: PaymentMethodRecoveryStep;
    }
  | Record<string, never> {
  try {
    const step: unknown = diagnostic?.step;
    if (typeof step !== "string" || !recoveryStepSet.has(step)) return {};
    return {
      payment_method_recovery_diagnostic_version: 1,
      payment_method_recovery_step: step as PaymentMethodRecoveryStep,
    };
  } catch {
    return {};
  }
}

/** Stripe delivery order is not change order; read source events before replacing an override. */
async function canReplaceSubscriptionDefault(
  stripe: Stripe,
  subscriptionId: string,
  customerEventCreated: number,
): Promise<boolean> {
  // Events are only retained for 30 days. An older replay cannot prove ordering.
  if (customerEventCreated < Date.now() / 1000 - 30 * 24 * 60 * 60)
    return false;
  let startingAfter: string | undefined;
  // Bound webhook work and fail closed if the relevant history cannot be exhausted.
  for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
    const page = await stripe.events.list({
      type: "customer.subscription.updated",
      created: { gte: customerEventCreated },
      limit: 100,
      ...(startingAfter && { starting_after: startingAfter }),
    });
    for (const event of page.data) {
      const current = event.data.object as Stripe.Subscription;
      const previous = event.data.previous_attributes as
        Partial<Stripe.Subscription> | undefined;
      if (
        current.id === subscriptionId &&
        previous &&
        Object.prototype.hasOwnProperty.call(
          previous,
          "default_payment_method",
        ) &&
        stripeObjectId(previous.default_payment_method) !==
          stripeObjectId(current.default_payment_method)
      ) {
        // Timestamps have second precision: preserve the override on a tie too.
        return false;
      }
    }
    if (!page.has_more) return true;
    startingAfter = page.data.at(-1)?.id;
    if (!startingAfter) return false;
  }
  return false;
}

/** Recover only the latest automatic renewal after an explicit default-card change. */
export async function recoverSubscriptionPayment({
  stripe,
  subscription,
  invoice,
  paymentMethodId,
  paymentIntent,
  selectionEventId,
  customerEventCreated,
  diagnostic,
}: {
  stripe: Stripe;
  subscription: Stripe.Subscription;
  invoice: Stripe.Invoice;
  paymentMethodId: string;
  paymentIntent?: Stripe.PaymentIntent | null;
  selectionEventId: string;
  customerEventCreated?: number;
  diagnostic?: PaymentMethodRecoveryDiagnostic;
}): Promise<"skipped" | "paid" | "pending"> {
  if (
    !["past_due", "unpaid"].includes(subscription.status) ||
    subscription.collection_method !== "charge_automatically" ||
    subscription.cancel_at_period_end ||
    subscription.cancel_at ||
    subscription.pause_collection ||
    stripeObjectId(subscription.latest_invoice) !== invoice.id ||
    invoiceSubscriptionId(invoice) !== subscription.id ||
    stripeObjectId(invoice.customer) !==
      stripeObjectId(subscription.customer) ||
    invoice.status !== "open" ||
    invoice.collection_method !== "charge_automatically" ||
    invoice.billing_reason !== "subscription_cycle" ||
    invoice.amount_remaining <= 0 ||
    (paymentIntent &&
      // A portal-canceled payment can still belong to an open renewal invoice.
      ["processing", "succeeded", "requires_capture", "canceled"].includes(
        paymentIntent.status,
      ))
  ) {
    return "skipped";
  }

  // A subscription-level default wins over the customer's new default. Keep
  // future renewals on the newly selected card as well as paying this invoice.
  if (stripeObjectId(subscription.default_payment_method) !== paymentMethodId) {
    if (customerEventCreated !== undefined) {
      markPaymentMethodRecoveryStep(
        diagnostic,
        "check_subscription_default_history",
      );
      if (
        !(await canReplaceSubscriptionDefault(
          stripe,
          subscription.id,
          customerEventCreated,
        ))
      )
        return "skipped";
    }
    markPaymentMethodRecoveryStep(diagnostic, "update_subscription_default");
    await stripe.subscriptions.update(
      subscription.id,
      { default_payment_method: paymentMethodId },
      {
        idempotencyKey: `recovery-card:${subscription.id}:${selectionEventId}`,
      },
    );
  }

  markPaymentMethodRecoveryStep(diagnostic, "pay_invoice");
  try {
    const paid = await stripe.invoices.pay(
      invoice.id,
      { payment_method: paymentMethodId },
      // Customer/subscription webhooks and retries must share the same key.
      { idempotencyKey: `recovery-payment:${invoice.id}:${paymentMethodId}` },
    );
    // Entitlements are restored exclusively by the existing invoice.paid path.
    return paid.status === "paid" ? "paid" : "pending";
  } catch (error) {
    // A replacement card can still decline or require customer authentication.
    // Acknowledge those outcomes; retry delivery only for operational failures.
    if (error instanceof Stripe.errors.StripeCardError) return "pending";
    if (
      error instanceof Stripe.errors.StripeInvalidRequestError &&
      error.code === "invoice_already_paid"
    ) {
      return "paid";
    }
    throw error;
  }
}
