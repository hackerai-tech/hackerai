"use client";

import { useState, type ReactNode } from "react";
import useSWR from "swr";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { toast } from "sonner";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { Button } from "@/components/ui/button";
import {
  BillingRequestError,
  getSubscriptionCancellationStatus,
  redirectToBillingPortal,
} from "@/lib/billing/client";
import { openSettingsDialog } from "@/lib/utils/settings-dialog";
import { PastDueBillingBanner } from "./PastDueBillingBanner";

async function getRecoveryStatus() {
  try {
    return await getSubscriptionCancellationStatus();
  } catch (error) {
    // Free accounts commonly have no billing account. A failed lookup or a
    // forbidden organization must not be mistaken for exhausted paid usage.
    if (
      error instanceof BillingRequestError &&
      error.status === 404 &&
      error.message === "No billing account found for this organization"
    ) {
      return { hasActiveSubscription: false, cancelAtPeriodEnd: false };
    }
    throw error;
  }
}

/** Only mount on blocked chat: no Stripe requests on normal chat traffic. */
export function BlockedChatBillingRecovery({
  children,
  onRetry,
}: {
  children: ReactNode;
  onRetry?: () => void;
}) {
  const { user, organizationId, loading } = useAuth();
  const { subscription } = useGlobalState();
  const [isOpening, setIsOpening] = useState(false);
  const { data, error, isLoading, isValidating, mutate } = useSWR(
    user && !loading
      ? ["blocked-chat-billing", user.id, organizationId ?? null]
      : null,
    getRecoveryStatus,
    {
      // All visible stops share a request, scoped to the current identity.
      dedupingInterval: 30_000,
      focusThrottleInterval: 30_000,
      refreshInterval: 0,
      shouldRetryOnError: false,
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
    },
  );

  const openPayment = async () => {
    if (isOpening) return;
    setIsOpening(true);
    try {
      const url = await redirectToBillingPortal("payment_method", {
        surface: "blocked_chat",
        returnPath: window.location.pathname,
      });
      window.location.href = url;
    } catch {
      toast.error("Could not open billing. Please try again.");
      setIsOpening(false);
    }
  };

  if (loading || isLoading || (isValidating && !data?.renewalPaymentRequired)) {
    return (
      <p role="status" className="p-3 text-sm text-muted-foreground">
        Checking billing…
      </p>
    );
  }
  if (!user) return <>{children}</>;

  if (error || !data) {
    const forbidden =
      error instanceof BillingRequestError && error.status === 403;
    return (
      <div role="status" className="rounded-lg border p-3 text-sm space-y-2">
        <p>
          {forbidden
            ? "Ask your billing administrator to check payment and usage for this account."
            : "We couldn't check whether this is a payment issue or a usage limit."}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => openSettingsDialog("Account")}
          >
            Account settings
          </Button>
          {onRetry && (
            <Button size="sm" variant="outline" onClick={onRetry}>
              Try again
            </Button>
          )}
          {!forbidden && (
            <Button
              size="sm"
              variant="outline"
              disabled={isValidating}
              onClick={() => void mutate()}
            >
              Check again
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (
    data.renewalPaymentRequired &&
    (data.subscriptionStatus === "past_due" ||
      data.subscriptionStatus === "unpaid")
  ) {
    return (
      <div className="my-2 space-y-2">
        <PastDueBillingBanner
          surface="blocked_chat"
          subscription={subscription}
          subscriptionStatus={data.subscriptionStatus}
          latestInvoiceId={data.latestInvoiceId}
          isOpening={isOpening}
          onUpdatePayment={() => void openPayment()}
        />
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const url = new URL(window.location.href);
            url.searchParams.set("refresh", "entitlements");
            // Refresh the actual entitlement session; never infer access from
            // opening the portal, changing a card, or returning to the app.
            window.location.href = url.toString();
          }}
        >
          Refresh chat after payment
        </Button>
      </div>
    );
  }

  if (
    data.subscriptionStatus === "past_due" ||
    data.subscriptionStatus === "unpaid"
  ) {
    return (
      <div role="status" className="rounded-lg border p-3 text-sm space-y-2">
        <p>
          Your subscription needs billing attention. Open Account settings to
          review your payment status.
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => openSettingsDialog("Account")}
        >
          Account settings
        </Button>
      </div>
    );
  }

  return <>{children}</>;
}
