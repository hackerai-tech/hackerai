"use client";

import React, { useState } from "react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Crown, Loader2 } from "lucide-react";
import { useGlobalState } from "@/app/contexts/GlobalState";

const SidebarUpgrade: React.FC = () => {
  const { user } = useAuth();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const { hasProPlan } = useGlobalState();

  const handleSubscribe = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();

    if (!user) {
      setError("Please sign in to upgrade");
      return;
    }

    setLoading(true);
    setError("");

    try {
      // Call API to create a new organization and subscribe to plan
      // The user will be redirected to Stripe Checkout
      const res = await fetch("/api/subscribe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      });

      const { error, url } = await res.json();

      if (!error && url) {
        return router.push(url);
      }

      setError(`Error subscribing to plan: ${error}`);
    } catch (err) {
      setError("An unexpected error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  if (!user) return null;

  // Don't show upgrade button if user already has pro
  if (hasProPlan) {
    return null;
  }

  return (
    <div className="p-3">
      <Button
        onClick={handleSubscribe}
        disabled={loading}
        className="w-full bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700 text-white border-0 shadow-sm"
        size="sm"
      >
        {loading ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Upgrading...
          </>
        ) : (
          <>
            <Crown className="mr-2 h-4 w-4" />
            Upgrade to Pro
          </>
        )}
      </Button>
      {error && (
        <p className="text-xs text-red-500 mt-2 text-center">{error}</p>
      )}
    </div>
  );
};

export default SidebarUpgrade;
