"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useGlobalState } from "@/app/contexts/GlobalState";
import {
  getSubscriptionCancellationStatus,
  redirectToBillingPortal,
} from "@/lib/billing/client";
import {
  PAID_FUNNEL_EVENTS,
  paidFunnelProperties,
} from "@/lib/analytics/paid-funnel";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import type { SubscriptionTier } from "@/types";

type PastDueStatus = "past_due" | "unpaid";

function isPaidSubscription(
  subscription: SubscriptionTier,
): subscription is Exclude<SubscriptionTier, "free"> {
  return subscription !== "free";
}

type PastDueBillingBannerProps = {
  surface: "chat_layout" | "account_settings";
  subscription: Exclude<SubscriptionTier, "free">;
  subscriptionStatus: PastDueStatus;
  isOpening: boolean;
  onUpdatePayment: () => void;
};

export function PastDueBillingBanner({
  surface,
  subscription,
  subscriptionStatus,
  isOpening,
  onUpdatePayment,
}: PastDueBillingBannerProps) {
  useEffect(() => {
    captureAuthenticatedEvent(
      PAID_FUNNEL_EVENTS.billingPastDueBannerImpressed,
      paidFunnelProperties({
        surface,
        subscription_tier: subscription,
        subscription_status: subscriptionStatus,
      }),
    );
  }, [subscription, subscriptionStatus, surface]);

  const handleUpdatePayment = () => {
    captureAuthenticatedEvent(
      PAID_FUNNEL_EVENTS.billingPastDuePaymentUpdateClicked,
      paidFunnelProperties({
        surface,
        subscription_tier: subscription,
        subscription_status: subscriptionStatus,
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

function PaidPastDueBillingNotice({
  subscription,
}: {
  subscription: Exclude<SubscriptionTier, "free">;
}) {
  const [subscriptionStatus, setSubscriptionStatus] =
    useState<PastDueStatus | null>(null);
  const [isOpening, setIsOpening] = useState(false);

  useEffect(() => {
    let ignore = false;
    getSubscriptionCancellationStatus()
      .then((status) => {
        if (ignore) return;
        setSubscriptionStatus(
          status.subscriptionStatus === "past_due" ||
            status.subscriptionStatus === "unpaid"
            ? status.subscriptionStatus
            : null,
        );
      })
      .catch(() => {
        if (!ignore) setSubscriptionStatus(null);
      });

    return () => {
      ignore = true;
    };
  }, [subscription]);

  if (!subscriptionStatus) return null;

  const handleUpdatePayment = async () => {
    if (isOpening) return;
    setIsOpening(true);
    try {
      const url = await redirectToBillingPortal("payment_method");
      window.location.href = url;
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to open billing portal",
      );
      setIsOpening(false);
    }
  };

  return (
    <PastDueBillingBanner
      surface="chat_layout"
      subscription={subscription}
      subscriptionStatus={subscriptionStatus}
      isOpening={isOpening}
      onUpdatePayment={() => void handleUpdatePayment()}
    />
  );
}

export function PastDueBillingNotice() {
  const { subscription } = useGlobalState();
  if (!isPaidSubscription(subscription)) return null;

  return (
    <PaidPastDueBillingNotice key={subscription} subscription={subscription} />
  );
}
