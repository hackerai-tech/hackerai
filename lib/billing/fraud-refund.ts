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

const getRefundAmountRaceMessage = (error: unknown): string | undefined => {
  if (!error || typeof error !== "object") return undefined;

  const stripeError = error as { message?: unknown; raw?: unknown };
  const rawError =
    stripeError.raw && typeof stripeError.raw === "object"
      ? (stripeError.raw as Record<string, unknown>)
      : undefined;
  const message = stripeError.message ?? rawError?.message;

  return typeof message === "string" ? message : undefined;
};

export function getRemainingRefundAmountCents(
  charge: Pick<Stripe.Charge, "amount" | "amount_refunded">,
): number {
  return Math.max(0, charge.amount - charge.amount_refunded);
}

export function getReportedRemainingRefundAmountCents(
  error: unknown,
): number | undefined {
  const message = getRefundAmountRaceMessage(error);
  if (!message) return undefined;

  const match =
    /^Refund amount \(\$[\d,]+\.\d{2}\) is greater than unrefunded amount on charge \(\$([\d,]+)\.(\d{2})\)$/.exec(
      message,
    );
  if (!match?.[1] || !match[2]) return undefined;

  const dollars = Number(match[1].replaceAll(",", ""));
  const cents = Number(match[2]);
  if (!Number.isSafeInteger(dollars) || !Number.isSafeInteger(cents)) {
    return undefined;
  }

  const amount = dollars * 100 + cents;
  return Number.isSafeInteger(amount) ? amount : undefined;
}

export function isRefundAmountRaceError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const stripeError = error as {
    code?: unknown;
    message?: unknown;
    param?: unknown;
    raw?: unknown;
    rawType?: unknown;
    statusCode?: unknown;
    type?: unknown;
  };
  const rawError =
    stripeError.raw && typeof stripeError.raw === "object"
      ? (stripeError.raw as Record<string, unknown>)
      : undefined;
  const statusCode = stripeError.statusCode ?? rawError?.statusCode;
  const code = stripeError.code ?? rawError?.code;

  if (statusCode !== 400) return false;
  if (code === "amount_too_large") return true;
  if (code != null) return false;

  const param = stripeError.param ?? rawError?.param;
  const message = getRefundAmountRaceMessage(error);
  const isInvalidRequest =
    stripeError.type === "StripeInvalidRequestError" ||
    stripeError.rawType === "invalid_request_error" ||
    rawError?.type === "invalid_request_error";

  return (
    isInvalidRequest &&
    param === "amount" &&
    typeof message === "string" &&
    /^Refund amount \(.+\) is greater than unrefunded amount on charge \(.+\)$/.test(
      message,
    )
  );
}

/**
 * Refund a charge for an early fraud warning.
 *
 * Idempotency keys include the observed refundable balance, so webhook retries
 * for the same balance collapse while a later delivery with a fresher balance
 * can make progress. If another refund wins the race after retrieval, refresh
 * the charge once and retry no more than the lower of its refreshed balance and
 * the balance Stripe reported in the exact refund-race response.
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
      const reportedRemainingAmount =
        getReportedRemainingRefundAmountCents(refundError);
      const refreshedCharge = await stripeClient.charges.retrieve(charge.id);
      const refreshedRemainingAmount =
        getRemainingRefundAmountCents(refreshedCharge);
      const retryAmount =
        reportedRemainingAmount === undefined
          ? refreshedRemainingAmount
          : Math.min(refreshedRemainingAmount, reportedRemainingAmount);

      if (retryAmount === 0) {
        console.log(
          `[Fraud Webhook] Refund skipped for ${charge.id} (EFW ${efwId}): charge has no refundable balance after refresh`,
        );
        return;
      }

      if (retryAmount < remainingAmount) {
        await stripeClient.refunds.create(
          {
            charge: charge.id,
            reason: "fraudulent",
            amount: retryAmount,
          },
          {
            idempotencyKey: `efw-refund:${efwId}:remaining:${retryAmount}`,
          },
        );
        console.log(
          `[Fraud Webhook] Refunded refreshed remaining balance of ${retryAmount} cents from charge ${charge.id} (early fraud warning ${efwId})`,
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
