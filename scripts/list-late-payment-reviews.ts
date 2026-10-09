import Stripe from "stripe";
import { listLatePaymentReviews } from "../lib/billing/late-payment-review";
import {
  invoiceSubscriptionId,
  stripeObjectId,
} from "../lib/billing/subscription-payment-failure";

async function main() {
  const [expectedAccount, mode] = process.argv.slice(2);
  if (
    !expectedAccount?.startsWith("acct_") ||
    !["test", "live"].includes(mode)
  ) {
    throw new Error(
      "Usage: pnpm exec tsx scripts/list-late-payment-reviews.ts <acct_id> <test|live>",
    );
  }
  // Explicit environment only. Never load credentials from another checkout.
  const key = process.env.STRIPE_SECRET_KEY;
  if (
    !key ||
    (!key.startsWith(`rk_${mode}_`) && !key.startsWith(`sk_${mode}_`))
  ) {
    throw new Error("Stripe credential mode mismatch");
  }
  const stripe = new Stripe(key);
  const account = await stripe.accounts.retrieveCurrent();
  if (account.id !== expectedAccount)
    throw new Error("Stripe account mismatch");
  const reviews = [];
  for await (const invoice of listLatePaymentReviews(stripe, mode === "live")) {
    reviews.push({
      invoiceId: invoice.id,
      customerId: stripeObjectId(invoice.customer),
      subscriptionId: invoiceSubscriptionId(invoice),
      amountPaid: invoice.amount_paid,
      currency: invoice.currency,
      paidAt: invoice.status_transitions.paid_at,
      reason: invoice.metadata?.hackeraiLatePaymentReviewReason,
      owner: invoice.metadata?.hackeraiLatePaymentReviewOwner,
    });
  }
  console.log(
    JSON.stringify({ accountId: account.id, mode, reviews }, null, 2),
  );
}

main().catch(() => {
  // SDK errors may contain request details. Keep credential-bearing diagnostics
  // out of support exports; a failure must never look like an empty queue.
  console.error(
    "Could not read billing reviews. Check account, mode, Stripe access and arguments.",
  );
  process.exitCode = 1;
});
