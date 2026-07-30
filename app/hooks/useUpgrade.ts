import { useRef, useState } from "react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { toast } from "sonner";
import {
  captureAuthenticatedEvent,
  getPostHogRequestHeaders,
  newCheckoutAttemptId,
} from "@/lib/analytics/client";
import {
  planLookupKeyToBillingInterval,
  planLookupKeyToTier,
  type PaidFunnelPlan,
} from "@/lib/analytics/paid-funnel";

export const useUpgrade = () => {
  const { user } = useAuth();
  const [upgradeLoading, setUpgradeLoading] = useState(false);
  const upgradeInFlightRef = useRef(false);

  const handleUpgrade = async (
    planKey?: PaidFunnelPlan,
    e?: React.MouseEvent<HTMLButtonElement | HTMLDivElement>,
    quantity?: number,
    currentSubscription?: "free" | "pro" | "pro-plus" | "ultra" | "team",
    analyticsContext: {
      source?: string;
      surface?: string;
      reason?: string;
      limit_type?: string;
    } = {},
  ) => {
    e?.preventDefault();

    // Prevent duplicate submits
    if (upgradeInFlightRef.current) {
      return;
    }

    if (!user) {
      toast.error("Please sign in to upgrade");
      return;
    }

    upgradeInFlightRef.current = true;
    setUpgradeLoading(true);

    let navigationStarted = false;

    try {
      const selectedPlan = planKey || "pro-monthly-plan";
      const checkoutAttemptId = newCheckoutAttemptId();
      const toTier = planLookupKeyToTier(selectedPlan);
      const billingInterval = planLookupKeyToBillingInterval(selectedPlan);
      const requestBody: {
        plan: string;
        quantity?: number;
        checkoutAttemptId: string;
        source?: string;
        surface?: string;
        reason?: string;
        limitType?: string;
        fromTier?: string;
      } = {
        plan: selectedPlan,
        checkoutAttemptId,
        source: analyticsContext.source,
        surface: analyticsContext.surface,
        reason: analyticsContext.reason,
        limitType: analyticsContext.limit_type,
        fromTier: currentSubscription ?? "free",
      };

      // Add quantity for team plans
      if (quantity && quantity > 1) {
        requestBody.quantity = quantity;
      }

      // Use regular checkout for new subscriptions (free users)
      if (!currentSubscription || currentSubscription === "free") {
        captureAuthenticatedEvent("checkout_intent_clicked", {
          checkout_attempt_id: checkoutAttemptId,
          plan: selectedPlan,
          quantity,
          from_tier: currentSubscription ?? "free",
          to_tier: toTier,
          billing_interval: billingInterval,
          surface: analyticsContext.surface,
          source: analyticsContext.source,
          reason: analyticsContext.reason,
          limit_type: analyticsContext.limit_type,
          checkout_type: "new_subscription",
        });

        const res = await fetch("/api/subscribe", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...getPostHogRequestHeaders(),
          },
          body: JSON.stringify(requestBody),
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          toast.error(
            data.error || `Something went wrong (HTTP ${res.status})`,
          );
          return;
        }

        const { error, url } = data;

        if (url) {
          captureAuthenticatedEvent("checkout_redirected", {
            checkout_attempt_id: checkoutAttemptId,
            plan: selectedPlan,
            quantity,
            from_tier: currentSubscription ?? "free",
            to_tier: toTier,
            billing_interval: billingInterval,
            surface: analyticsContext.surface,
            source: analyticsContext.source,
            reason: analyticsContext.reason,
            limit_type: analyticsContext.limit_type,
            checkout_type: "new_subscription",
          });
          window.location.href = url;
          navigationStarted = true;
          return;
        }

        if (error) {
          toast.error(`Error: ${error}`);
        } else {
          toast.error("Unknown error creating checkout session");
        }
      } else {
        // For existing subscribers, use immediate subscription update
        // This prevents the "free credit" exploit
        captureAuthenticatedEvent("subscription_change_intent_clicked", {
          checkout_attempt_id: checkoutAttemptId,
          plan: selectedPlan,
          quantity,
          from_tier: currentSubscription,
          to_tier: toTier,
          billing_interval: billingInterval,
          surface: analyticsContext.surface,
          source: analyticsContext.source,
          reason: analyticsContext.reason,
          limit_type: analyticsContext.limit_type,
          checkout_type: "subscription_change",
        });

        const res = await fetch("/api/subscription-details", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...getPostHogRequestHeaders(),
          },
          body: JSON.stringify({
            plan: planKey,
            confirm: true,
            quantity: quantity,
            checkoutAttemptId,
            source: analyticsContext.source,
            surface: analyticsContext.surface,
            reason: analyticsContext.reason,
            limitType: analyticsContext.limit_type,
            fromTier: currentSubscription,
          }),
        });

        const result = await res.json().catch(() => ({}));

        if (!res.ok) {
          toast.error(
            result.error || `Something went wrong (HTTP ${res.status})`,
          );
          return;
        }

        if (result.success) {
          // Subscription updated successfully, refresh to show new plan
          const url = new URL(window.location.href);
          url.searchParams.set("refresh", "entitlements");
          url.hash = ""; // Remove #pricing hash if present
          window.location.href = url.toString();
          navigationStarted = true;
        } else if (result.invoiceUrl) {
          // Payment failed, redirect to invoice payment page
          window.location.href = result.invoiceUrl;
          navigationStarted = true;
        } else if (result.error) {
          toast.error(`Error: ${result.error}`);
        } else {
          toast.error("Unknown error updating subscription");
        }
      }
    } catch (err) {
      // Surface real error messages when err is an Error
      if (err instanceof Error) {
        toast.error(err.message);
      } else {
        toast.error("An unexpected error occurred");
      }
    } finally {
      if (!navigationStarted) {
        upgradeInFlightRef.current = false;
        setUpgradeLoading(false);
      }
    }
  };

  return {
    upgradeLoading,
    handleUpgrade,
  };
};
