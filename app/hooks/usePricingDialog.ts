import { useEffect, useRef, useState } from "react";
import type { SubscriptionTier } from "@/types";
import {
  captureAuthenticatedEvent,
  captureUpgradeCtaClick,
} from "@/lib/analytics/client";

type PricingRedirectAnalytics = {
  surface?: string;
  source?: string;
  from_tier?: SubscriptionTier;
  reason?: string;
  limit_type?: string;
  cta_text?: string;
};

export const usePricingDialog = (subscription?: SubscriptionTier) => {
  const [showPricing, setShowPricing] = useState(false);
  const capturedPricingViewRef = useRef(false);

  useEffect(() => {
    // Check if URL hash is #pricing
    const checkHash = () => {
      const shouldShow = window.location.hash === "#pricing";

      // Don't show pricing dialog for ultra/team users
      if (shouldShow && (subscription === "ultra" || subscription === "team")) {
        // Clear the hash
        window.history.replaceState(
          null,
          document.title || "",
          window.location.pathname + window.location.search,
        );
        setShowPricing(false);
        return;
      }

      setShowPricing(shouldShow);
      if (!shouldShow) {
        capturedPricingViewRef.current = false;
        return;
      }

      if (!capturedPricingViewRef.current) {
        if (
          captureAuthenticatedEvent("pricing_viewed", {
            subscription,
          })
        ) {
          capturedPricingViewRef.current = true;
        }
      }
    };

    // Check on mount
    checkHash();

    // Listen for hash changes
    window.addEventListener("hashchange", checkHash);

    return () => {
      window.removeEventListener("hashchange", checkHash);
    };
  }, [subscription]);

  const handleClosePricing = () => {
    setShowPricing(false);
    // Remove hash from URL
    if (window.location.hash === "#pricing") {
      window.history.replaceState(
        null,
        document.title || "",
        window.location.pathname + window.location.search,
      );
    }
  };

  const openPricing = () => {
    // Don't allow opening pricing for ultra/team users
    if (subscription === "ultra" || subscription === "team") {
      return;
    }
    window.location.hash = "pricing";
  };

  return {
    showPricing,
    handleClosePricing,
    openPricing,
  };
};

// Utility function to redirect to pricing (can be used without the hook)
// Note: This doesn't check subscription tier, so use sparingly
// Consider using openPricing from the hook instead when possible
export const redirectToPricing = (analytics: PricingRedirectAnalytics = {}) => {
  captureUpgradeCtaClick({
    surface: analytics.surface ?? "unknown",
    source: analytics.source ?? "redirect_to_pricing",
    ...(analytics.from_tier && { from_tier: analytics.from_tier }),
    ...(analytics.reason && { reason: analytics.reason }),
    ...(analytics.limit_type && { limit_type: analytics.limit_type }),
    ...(analytics.cta_text && { cta_text: analytics.cta_text }),
  });
  window.location.hash = "pricing";
};
