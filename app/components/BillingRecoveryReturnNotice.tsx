"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { getSubscriptionCancellationStatus } from "@/lib/billing/client";

const NOTICE_ID = "billing-recovery-return";

/** Checks Stripe's invoice state after returning from a payment-method flow. */
export function BillingRecoveryReturnNotice() {
  const latestCheck = useRef(0);
  const returnedFromPortal = useRef(false);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("billing-recovery-return") === "1") {
      returnedFromPortal.current = true;
      url.searchParams.delete("billing-recovery-return");
      window.history.replaceState(window.history.state, "", url.toString());
    }
    if (!returnedFromPortal.current) return;
    let mounted = true;

    const checkPayment = async () => {
      const checkId = ++latestCheck.current;
      try {
        const status = await getSubscriptionCancellationStatus();
        if (!mounted || checkId !== latestCheck.current) return;
        if (
          status.renewalInvoicePaid &&
          (status.subscriptionStatus === "active" ||
            status.subscriptionStatus === "trialing")
        ) {
          toast.success("Your renewal invoice is paid. Your plan is active.", {
            id: NOTICE_ID,
          });
        } else if (status.renewalPaymentRequired) {
          const detail =
            status.renewalPaymentFailure === "insufficient_funds"
              ? "The latest payment was declined for insufficient funds."
              : status.renewalPaymentFailure === "authentication_required"
                ? "The latest payment needs authentication."
                : status.renewalPaymentFailure === "declined"
                  ? "The latest payment was declined."
                  : "A successful payment has not been confirmed yet.";
          toast.error("Your renewal invoice is still unpaid", {
            id: NOTICE_ID,
            description: `${detail} Check your payment in billing to restore access.`,
            duration: Infinity,
            action: {
              label: "Check again",
              onClick: () => void checkPayment(),
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
        if (!mounted || checkId !== latestCheck.current) return;
        toast.error("We couldn't verify the payment yet", {
          id: NOTICE_ID,
          description: "Check your invoice in billing or try again.",
          action: { label: "Check again", onClick: () => void checkPayment() },
        });
      }
    };

    void checkPayment();
    return () => {
      mounted = false;
    };
  }, []);

  return null;
}
