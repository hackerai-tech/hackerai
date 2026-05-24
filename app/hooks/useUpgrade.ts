import { useState } from "react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { toast } from "sonner";

export const useUpgrade = () => {
  const { user } = useAuth();
  const [upgradeLoading, setUpgradeLoading] = useState(false);

  const handleUpgrade = async (
    planKey?:
      | "pro-monthly-plan"
      | "pro-plus-monthly-plan"
      | "ultra-monthly-plan"
      | "pro-yearly-plan"
      | "pro-plus-yearly-plan"
      | "ultra-yearly-plan"
      | "team-monthly-plan"
      | "team-yearly-plan",
    e?: React.MouseEvent<HTMLButtonElement | HTMLDivElement>,
    quantity?: number,
    currentSubscription?: "free" | "pro" | "pro-plus" | "ultra" | "team",
  ) => {
    e?.preventDefault();

    // Prevent duplicate submits
    if (upgradeLoading) {
      return;
    }

    if (!user) {
      toast.error("Please sign in to upgrade");
      return;
    }

    setUpgradeLoading(true);

    try {
      const requestBody: { plan: string; quantity?: number } = {
        plan: planKey || "pro-monthly-plan",
      };

      // Add quantity for team plans
      if (quantity && quantity > 1) {
        requestBody.quantity = quantity;
      }

      // Use regular checkout for new subscriptions (free users)
      if (!currentSubscription || currentSubscription === "free") {
        const res = await fetch("/api/subscribe", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
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
          window.location.href = url;
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
        const res = await fetch("/api/subscription-details", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            plan: planKey,
            confirm: true,
            quantity: quantity,
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
        } else if (result.invoiceUrl) {
          // Payment failed, redirect to invoice payment page
          window.location.href = result.invoiceUrl;
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
      setUpgradeLoading(false);
    }
  };

  return {
    upgradeLoading,
    handleUpgrade,
  };
};
