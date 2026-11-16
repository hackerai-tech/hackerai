"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { v4 as uuidv4 } from "uuid";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { getSubscriptionCancellationStatus } from "@/lib/billing/client";
import type { SubscriptionCancellationStatus } from "@/lib/billing/api-types";
import {
  captureQueuedAuthenticatedEvent,
  getPermittedAnalyticsUserId,
} from "@/lib/analytics/client";
import { paidFunnelProperties } from "@/lib/analytics/paid-funnel";
import { openSettingsDialog } from "@/lib/utils/settings-dialog";
import { reloadWithEntitlementRefresh } from "@/lib/auth/entitlement-refresh-navigation";

const NOTICE_ID = "billing-recovery-return";
// Kept in sync with BillingRecoveryPanel's handoff trace event.
const HANDOFF_EVENT = "billing_recovery_handoff";

type ReturnPaymentState =
  | "review_required"
  | "no_subscription"
  | "paid"
  | "unpaid"
  | "active_unconfirmed"
  | "unconfirmed"
  | "check_failed";

function returnPaymentState(
  status: SubscriptionCancellationStatus,
): ReturnPaymentState {
  if (status.checkoutRequiresReview) return "review_required";
  if (!status.hasActiveSubscription) return "no_subscription";
  if (
    status.renewalInvoicePaid &&
    (status.subscriptionStatus === "active" ||
      status.subscriptionStatus === "trialing")
  )
    return "paid";
  if (status.renewalPaymentRequired) return "unpaid";
  if (status.subscriptionStatus === "active") return "active_unconfirmed";
  return "unconfirmed";
}

/** Checks Stripe's invoice state after returning from a payment-method flow. */
export function BillingRecoveryReturnNotice() {
  const { user, organizationId, loading } = useAuth();
  const scope = !loading && user ? `${user.id}:${organizationId ?? ""}` : null;
  const latestCheck = useRef(0);
  const returnedFromPortal = useRef(false);
  // The account that came back from billing; another account never sees it.
  const returnScope = useRef<string | null>(null);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("billing-recovery-return") === "1") {
      returnedFromPortal.current = true;
      url.searchParams.delete("billing-recovery-return");
      window.history.replaceState(window.history.state, "", url.toString());
    }
  }, []);

  useEffect(() => {
    // Wait for the signed-in identity before reading or reporting billing.
    if (!returnedFromPortal.current || !scope) return;
    if (returnScope.current && returnScope.current !== scope) return;
    returnScope.current = scope;
    let active = true;
    const isCurrent = (checkId: number) =>
      active && checkId === latestCheck.current;
    const trace = (
      state: ReturnPaymentState,
      status?: SubscriptionCancellationStatus,
    ) => {
      // Auth and analytics settle independently during account changes.
      if (getPermittedAnalyticsUserId() !== user?.id) return;
      captureQueuedAuthenticatedEvent({
        event: HANDOFF_EVENT,
        properties: paidFunnelProperties({
          handoff_stage: "returned",
          payment_state: state,
          ...(status?.subscriptionStatus && {
            subscription_status: status.subscriptionStatus,
          }),
          ...(status?.latestInvoiceId && {
            stripe_invoice_id: status.latestInvoiceId,
          }),
        }),
        dedupeKey: `returned:${uuidv4()}`,
      });
    };

    const checkPayment = async () => {
      const checkId = ++latestCheck.current;
      try {
        const status = await getSubscriptionCancellationStatus();
        if (!isCurrent(checkId)) return;
        trace(returnPaymentState(status), status);
        if (status.checkoutRequiresReview) {
          toast.warning(
            status.billingReviewUnavailable
              ? "We couldn't verify your billing status"
              : "Your previous subscription payment still needs review",
            {
              id: NOTICE_ID,
              description: status.billingReviewUnavailable
                ? "We couldn't check your payment history. Open Account settings to retry or get billing help."
                : "Updating your card does not restart an ended subscription. Open Account settings for billing help.",
              action: {
                label: "Review billing",
                onClick: () => openSettingsDialog("Account"),
              },
            },
          );
        } else if (!status.hasActiveSubscription) {
          toast.info("You can choose a plan to subscribe again", {
            id: NOTICE_ID,
            description: "Updating a card does not start a subscription.",
          });
        } else if (
          status.renewalInvoicePaid &&
          (status.subscriptionStatus === "active" ||
            status.subscriptionStatus === "trialing")
        ) {
          toast.success(
            "Your renewal invoice is paid. Refresh to update your access.",
            {
              id: NOTICE_ID,
              action: {
                label: "Refresh",
                onClick: reloadWithEntitlementRefresh,
              },
            },
          );
        } else if (status.renewalPaymentRequired) {
          const detail =
            status.renewalPaymentFailure === "insufficient_funds"
              ? "The latest payment was declined for insufficient funds."
              : status.renewalPaymentFailure === "authentication_required"
                ? "The latest payment needs authentication."
                : status.renewalPaymentFailure === "declined"
                  ? "The latest payment was declined."
                  : "A successful payment has not been confirmed yet.";
          // One action and a short reason keep the text readable at narrow
          // widths; a finite, closable toast never covers Send for long.
          toast.error("Your renewal invoice is still unpaid", {
            id: NOTICE_ID,
            description: detail,
            closeButton: true,
            action: {
              label: "Resolve payment",
              onClick: () => openSettingsDialog("Account"),
            },
          });
        } else if (status.subscriptionStatus === "active") {
          toast.info(
            "Your plan is active. Check billing for your latest invoice.",
            {
              id: NOTICE_ID,
              action: {
                label: "Check again",
                onClick: () => void checkPayment(),
              },
            },
          );
        } else {
          toast.warning("Payment is not confirmed yet", {
            id: NOTICE_ID,
            description:
              "Check your invoice in billing. Access returns after payment succeeds.",
            action: {
              label: "Check again",
              onClick: () => void checkPayment(),
            },
          });
        }
      } catch {
        if (!isCurrent(checkId)) return;
        trace("check_failed");
        toast.error("We couldn't verify the payment yet", {
          id: NOTICE_ID,
          description: "Check your invoice in billing or try again.",
          action: { label: "Check again", onClick: () => void checkPayment() },
        });
      }
    };

    void checkPayment();
    return () => {
      active = false;
    };
  }, [scope, user?.id]);

  return null;
}
