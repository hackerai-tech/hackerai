import { useEffect, useState } from "react";
import type { SubscriptionTier } from "@/types";

export const usePricingDialog = (subscription?: SubscriptionTier) => {
  const [showPricing, setShowPricing] = useState(false);

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
export const redirectToPricing = () => {
  window.location.hash = "pricing";
};
