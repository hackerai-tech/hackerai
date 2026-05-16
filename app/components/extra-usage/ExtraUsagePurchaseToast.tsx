"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";

/**
 * Shows a sonner toast after a user returns from Stripe Checkout for extra
 * usage credits. The confirm routes redirect here with purchase params:
 * personal uses ?extra-usage-purchased=true&amount=<dollars>, team uses
 * ?team-extra-usage-purchased=true&amount=<dollars>. Async payment methods
 * land with a matching pending param while the webhook completes the credit.
 *
 * Strips the params from the URL after firing so a reload doesn't re-show it.
 * Reads directly from window.location to match the existing page pattern and
 * avoid forcing a Suspense boundary via next/navigation's useSearchParams.
 */
export function ExtraUsagePurchaseToast() {
  const firedRef = useRef(false);

  useEffect(() => {
    if (firedRef.current) return;

    const url = new URL(window.location.href);
    const isTeamPurchase =
      url.searchParams.get("team-extra-usage-purchased") === "true";
    const isPersonalPurchase =
      url.searchParams.get("extra-usage-purchased") === "true";

    if (!isTeamPurchase && !isPersonalPurchase) return;

    firedRef.current = true;

    const pending =
      url.searchParams.get(
        isTeamPurchase ? "team-extra-usage-pending" : "extra-usage-pending",
      ) === "true";
    const amountRaw = url.searchParams.get("amount");
    const amount = amountRaw ? Number(amountRaw) : NaN;
    const amountLabel =
      Number.isFinite(amount) && amount > 0 ? `$${amount}` : null;

    if (pending) {
      toast.info("Payment received", {
        description: amountLabel
          ? `${amountLabel} in ${isTeamPurchase ? "team " : ""}credits will be added once your payment finalizes.`
          : isTeamPurchase
            ? "Your team credits will be added once your payment finalizes."
            : "Your credits will be added once your payment finalizes.",
      });
    } else {
      toast.success("Payment successful", {
        description: amountLabel
          ? `Added ${amountLabel} in ${isTeamPurchase ? "team " : ""}extra usage credits.`
          : isTeamPurchase
            ? "Team extra usage credits added to your team balance."
            : "Extra usage credits added to your balance.",
      });
    }

    url.searchParams.delete("extra-usage-purchased");
    url.searchParams.delete("extra-usage-pending");
    url.searchParams.delete("team-extra-usage-purchased");
    url.searchParams.delete("team-extra-usage-pending");
    url.searchParams.delete("amount");
    // Preserve Next.js App Router's internal history state (routing tree,
    // scroll restoration) — passing {} would clobber it.
    window.history.replaceState(
      window.history.state,
      "",
      url.pathname + url.search + url.hash,
    );
  }, []);

  return null;
}
