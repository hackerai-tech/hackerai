import type Stripe from "stripe";

type FraudRefundStripeClient = {
  charges: {
    retrieve: (chargeId: string) => Promise<Stripe.Charge>;
  };
  refunds: {
    create: (
      params: {
        amount: number;
        charge: string;
        reason: "fraudulent";
      },
      options: { idempotencyKey: string },
    ) => Promise<unknown>;
  };
};

const TERMINAL_REFUND_ERROR_CODES = new Set([
  "charge_already_refunded",
  "charge_disputed",
  "charge_not_refundable",
]);

export function getRemainingRefundAmountCents(
  charge: Pick<Stripe.Charge, "amount" | "amount_refunded">,
): number {
  return Math.max(0, charge.amount - charge.amount_refunded);
}

export function isRefundAmountRaceError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const stripeError = error as { code?: unknown; statusCode?: unknown };
  return (
    stripeError.statusCode === 400 && stripeError.code === "amount_too_large"
  );
}

/**
 * Refund a charge for an early fraud warning.
 *
 * Idempotency keys include the observed refundable balance, so webhook retries
 * for the same balance collapse while a later delivery with a fresher balance
 * can make progress. If another refund wins the race after retrieval, refresh
 * the charge once and retry no more than its current remaining balance.
 *
 * Terminal failures are treated as success because there is nothing to retry.
 * All other failures propagate so Stripe can retry the webhook delivery.
 */
export async function refundChargeForEFW(
  stripeClient: FraudRefundStripeClient,
  charge: Stripe.Charge,
  efwId: string,
): Promise<void> {
  const remainingAmount = getRemainingRefundAmountCents(charge);
  if (remainingAmount === 0) {
    console.log(
      `[Fraud Webhook] Refund skipped for ${charge.id} (EFW ${efwId}): charge has no refundable balance`,
    );
    return;
  }

  let refundError: unknown;

  try {
    await stripeClient.refunds.create(
      {
        charge: charge.id,
        reason: "fraudulent",
        amount: remainingAmount,
      },
      { idempotencyKey: `efw-refund:${efwId}:${remainingAmount}` },
    );
    console.log(
      `[Fraud Webhook] Refunded ${remainingAmount} cents from charge ${charge.id} (early fraud warning ${efwId})`,
    );
    return;
  } catch (error) {
    refundError = error;
  }

  if (isRefundAmountRaceError(refundError)) {
    try {
      const refreshedCharge = await stripeClient.charges.retrieve(charge.id);
      const refreshedRemainingAmount =
        getRemainingRefundAmountCents(refreshedCharge);

      if (refreshedRemainingAmount === 0) {
        console.log(
          `[Fraud Webhook] Refund skipped for ${charge.id} (EFW ${efwId}): charge has no refundable balance after refresh`,
        );
        return;
      }

      if (refreshedRemainingAmount < remainingAmount) {
        await stripeClient.refunds.create(
          {
            charge: charge.id,
            reason: "fraudulent",
            amount: refreshedRemainingAmount,
          },
          {
            idempotencyKey: `efw-refund:${efwId}:remaining:${refreshedRemainingAmount}`,
          },
        );
        console.log(
          `[Fraud Webhook] Refunded refreshed remaining balance of ${refreshedRemainingAmount} cents from charge ${charge.id} (early fraud warning ${efwId})`,
        );
        return;
      }
    } catch (error) {
      refundError = error;
    }
  }

  const terminalError =
    refundError && typeof refundError === "object"
      ? (refundError as { code?: unknown; statusCode?: unknown })
      : null;
  if (
    terminalError?.statusCode === 400 &&
    typeof terminalError.code === "string" &&
    TERMINAL_REFUND_ERROR_CODES.has(terminalError.code)
  ) {
    console.log(
      `[Fraud Webhook] Refund skipped for ${charge.id} (EFW ${efwId}): ${terminalError.code}`,
    );
    return;
  }

  console.error(
    `[Fraud Webhook] Refund failed for ${charge.id} (EFW ${efwId}):`,
    refundError,
  );
  throw refundError;
}
