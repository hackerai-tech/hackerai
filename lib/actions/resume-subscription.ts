"use server";

import { api } from "@/convex/_generated/api";
import { getBillingActionContext } from "@/lib/actions/billing-context";
import { BILLING_ERRORS } from "@/lib/billing/billing-errors";
import type { ResumeSubscriptionResult } from "@/lib/billing/api-types";
import { resumePausedSubscription } from "@/lib/billing/pause-resume";
import { getConvexClient } from "@/lib/db/convex-client";
import { phLogger } from "@/lib/posthog/server";

/** "Resume now" from account settings while a retention pause is active. */
export default async function resumeSubscriptionAction(): Promise<ResumeSubscriptionResult> {
  const { organizationId, user, stripeCustomerId } =
    await getBillingActionContext();
  const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    phLogger.error("subscription_resume_service_key_missing", {
      userId: user.id,
      org_id: organizationId,
    });
    throw new Error(BILLING_ERRORS.noPausedSubscription);
  }

  const pause = await getConvexClient().query(
    api.subscriptionPauses.getActivePauseForUser,
    { serviceKey, userId: user.id },
  );
  if (!pause || pause.stripeCustomerId !== stripeCustomerId) {
    throw new Error(BILLING_ERRORS.noPausedSubscription);
  }

  const result = await resumePausedSubscription(pause, { trigger: "manual" });

  switch (result.outcome) {
    case "resumed":
      return {
        resumed: true,
        stripeSubscriptionId: result.stripeSubscriptionId,
        alreadyActive: false,
      };
    case "superseded":
      return {
        resumed: true,
        stripeSubscriptionId: result.stripeSubscriptionId,
        alreadyActive: true,
      };
    case "not_claimable":
      // Another resume (cron or a second click) is already in flight.
      throw new Error(BILLING_ERRORS.noPausedSubscription);
    case "failed":
      throw new Error(
        result.failureKind === "no_payment_method"
          ? BILLING_ERRORS.resumeNoPaymentMethod
          : result.failureKind === "payment_failed"
            ? BILLING_ERRORS.resumePaymentFailed
            : result.message,
      );
  }
}
