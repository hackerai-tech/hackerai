"use server";

import { getBillingActionContext } from "@/lib/actions/billing-context";
import type { RetentionOffers } from "@/lib/billing/api-types";
import { CANCELLATION_REASON_INPUT_ERRORS } from "@/lib/billing/cancellation-reason-input";
import { isCancellationReasonCategory } from "@/lib/billing/cancellation-reasons";
import {
  buildRetentionOffers,
  evaluateRetentionOffersForUser,
} from "@/lib/billing/retention-offer-evaluation";

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

  const { user, stripeCustomerId } = await getBillingActionContext();
  const evaluation = await evaluateRetentionOffersForUser({
    userId: user.id,
    stripeCustomerId,
    reasonCategory: input.reasonCategory,
  });

  return buildRetentionOffers(evaluation);
}
