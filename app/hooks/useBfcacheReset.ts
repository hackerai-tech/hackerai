import { useEffect } from "react";

/**
 * Hook that resets state when page is restored from bfcache (back-forward cache).
 * Use this for loading states that should reset when user navigates back.
 *
 * @param resetFn - Function to call when page is restored from bfcache
 */
export function useBfcacheReset(resetFn: () => void) {
  useEffect(() => {
    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        resetFn();
      }
    };

    window.addEventListener("pageshow", handlePageShow);
    return () => window.removeEventListener("pageshow", handlePageShow);
  }, [resetFn]);
}
