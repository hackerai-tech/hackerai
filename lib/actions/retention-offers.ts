"use server";

import { getBillingActionContext } from "@/lib/actions/billing-context";
import type { RetentionOffers } from "@/lib/billing/api-types";
import { CANCELLATION_REASON_INPUT_ERRORS } from "@/lib/billing/cancellation-reason-input";
import {
  isCancellationReasonCategory,
  isCancellationReasonSubcategory,
  isCancellationReasonSubcategoryForCategory,
} from "@/lib/billing/cancellation-reasons";
import {
  PAID_FUNNEL_EVENTS,
  paidFunnelProperties,
} from "@/lib/analytics/paid-funnel";
import {
  buildRetentionOffers,
  evaluateRetentionOffersForUser,
  previewDowngradeRenewalCharge,
  retentionOfferEvaluationProperties,
} from "@/lib/billing/retention-offer-evaluation";
import { phLogger } from "@/lib/posthog/server";

type GetRetentionOffersInput = {
  reasonCategory?: unknown;
  reasonSubcategory?: unknown;
};

/** Preview which retention offers apply to the selected cancellation reason. */
export default async function getRetentionOffersAction(
  input: GetRetentionOffersInput,
): Promise<RetentionOffers> {
  const { reasonCategory } = input;
  if (!isCancellationReasonCategory(reasonCategory)) {
    throw new Error(CANCELLATION_REASON_INPUT_ERRORS.missingCategory);
  }
  // The follow-up answer is optional here, but when sent it must belong to
  // the main reason, as it does when the offer is accepted.
  const reasonSubcategory =
    input.reasonSubcategory === undefined || input.reasonSubcategory === null
      ? undefined
      : input.reasonSubcategory;
  if (
    reasonSubcategory !== undefined &&
    (!isCancellationReasonSubcategory(reasonSubcategory) ||
      !isCancellationReasonSubcategoryForCategory(
        reasonCategory,
        reasonSubcategory,
      ))
  ) {
    throw new Error(CANCELLATION_REASON_INPUT_ERRORS.missingSubcategory);
  }

  const { organizationId, user, stripeCustomerId } =
    await getBillingActionContext();
  const evaluation = await evaluateRetentionOffersForUser({
    userId: user.id,
    stripeCustomerId,
    reasonCategory,
    reasonSubcategory,
  });
  const renewalPreview =
    evaluation.downgrade.eligible && evaluation.downgradeTarget
      ? await previewDowngradeRenewalCharge({
          stripeCustomerId,
          subscription: evaluation.subscription,
          target: evaluation.downgradeTarget,
        })
      : undefined;

  // Server-side record of every decision, including the silent "no offer"
  // outcomes the client never reports.
  phLogger.event(
    PAID_FUNNEL_EVENTS.retentionOfferEvaluated,
    paidFunnelProperties({
      userId: user.id,
      org_id: organizationId,
      stripe_customer_id: stripeCustomerId,
      surface: "cancel_subscription_dialog",
      source: "account_settings",
      ...retentionOfferEvaluationProperties(
        evaluation,
        reasonCategory,
        reasonSubcategory,
      ),
      ...(renewalPreview && {
        downgrade_charge_display:
          renewalPreview.status === "verified"
            ? "stripe_invoice_preview"
            : "regular_rate",
        downgrade_charge_preview_unavailable_reason:
          renewalPreview.status === "verified"
            ? undefined
            : renewalPreview.reason,
      }),
    }),
  );

  return buildRetentionOffers(evaluation, renewalPreview);
}
