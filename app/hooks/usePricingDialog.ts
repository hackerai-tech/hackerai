import { useEffect, useState } from "react";

export const usePricingDialog = () => {
  const [showPricing, setShowPricing] = useState(false);

  useEffect(() => {
    // Check if URL hash is #pricing
    const checkHash = () => {
      setShowPricing(window.location.hash === "#pricing");
    };

    // Check on mount
    checkHash();

    // Listen for hash changes
    window.addEventListener("hashchange", checkHash);

    return () => {
      window.removeEventListener("hashchange", checkHash);
    };
  }, []);

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
    window.location.hash = "pricing";
  };

  return {
    showPricing,
    handleClosePricing,
    openPricing,
  };
};

// Utility function to redirect to pricing (can be used without the hook)
export const redirectToPricing = () => {
  window.location.hash = "pricing";
};
