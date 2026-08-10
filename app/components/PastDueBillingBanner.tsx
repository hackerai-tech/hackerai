"use client";

import { useEffect } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  PAID_FUNNEL_EVENTS,
  paidFunnelProperties,
} from "@/lib/analytics/paid-funnel";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import type { SubscriptionTier } from "@/types";

type PastDueBillingBannerProps = {
  surface: "account_settings";
  subscription: Exclude<SubscriptionTier, "free">;
  subscriptionStatus: "past_due";
  latestInvoiceId?: string;
  isOpening: boolean;
  onUpdatePayment: () => void;
};

export function PastDueBillingBanner({
  surface,
  subscription,
  subscriptionStatus,
  latestInvoiceId,
  isOpening,
  onUpdatePayment,
}: PastDueBillingBannerProps) {
  useEffect(() => {
    captureAuthenticatedEvent(
      PAID_FUNNEL_EVENTS.recoveryPromptImpressed,
      paidFunnelProperties({
        surface,
        subscription_tier: subscription,
        subscription_status: subscriptionStatus,
        ...(latestInvoiceId && { stripe_invoice_id: latestInvoiceId }),
      }),
    );
  }, [latestInvoiceId, subscription, subscriptionStatus, surface]);

  const handleUpdatePayment = () => {
    captureAuthenticatedEvent(
      PAID_FUNNEL_EVENTS.billingPastDuePaymentUpdateClicked,
      paidFunnelProperties({
        surface,
        subscription_tier: subscription,
        subscription_status: subscriptionStatus,
        ...(latestInvoiceId && { stripe_invoice_id: latestInvoiceId }),
      }),
    );
    onUpdatePayment();
  };

  return (
    <div
      role="alert"
      className="flex flex-col gap-3 border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 items-start gap-3">
        <AlertTriangle
          aria-hidden="true"
          className="mt-0.5 h-4 w-4 shrink-0 text-amber-500"
        />
        <p className="text-foreground">
          Your renewal payment failed—update your payment method to keep your
          plan.
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="shrink-0 border-amber-500/40 bg-background/80 hover:bg-amber-500/10"
        disabled={isOpening}
        onClick={handleUpdatePayment}
      >
        {isOpening ? (
          <>
            <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
            Opening...
          </>
        ) : (
          "Update payment"
        )}
      </Button>
    </div>
  );
}
