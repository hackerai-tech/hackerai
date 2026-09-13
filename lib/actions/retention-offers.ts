"use server";

import { getBillingActionContext } from "@/lib/actions/billing-context";
import type { RetentionOffers } from "@/lib/billing/api-types";
import { CANCELLATION_REASON_INPUT_ERRORS } from "@/lib/billing/cancellation-reason-input";
import { isCancellationReasonCategory } from "@/lib/billing/cancellation-reasons";
import {
  PAID_FUNNEL_EVENTS,
  paidFunnelProperties,
} from "@/lib/analytics/paid-funnel";
import {
  buildRetentionOffers,
  evaluateRetentionOffersForUser,
  retentionOfferEvaluationProperties,
} from "@/lib/billing/retention-offer-evaluation";
import { phLogger } from "@/lib/posthog/server";

type GetRetentionOffersInput = {
  reasonCategory?: unknown;
};

/** Preview which retention offers apply to the selected cancellation reason. */
export default async function getRetentionOffersAction(
  input: GetRetentionOffersInput,
): Promise<RetentionOffers> {
  if (!isCancellationReasonCategory(input.reasonCategory)) {
    throw new Error(CANCELLATION_REASON_INPUT_ERRORS.missingCategory);
  }

  const { organizationId, user, stripeCustomerId } =
    await getBillingActionContext();
  const evaluation = await evaluateRetentionOffersForUser({
    userId: user.id,
    stripeCustomerId,
    reasonCategory: input.reasonCategory,
  });

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
      ...retentionOfferEvaluationProperties(evaluation, input.reasonCategory),
    }),
  );

  return buildRetentionOffers(evaluation);
}
