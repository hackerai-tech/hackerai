"use client";

import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import redirectToBillingPortal from "@/lib/actions/billing-portal";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { redirectToPricing } from "@/app/hooks/usePricingDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { X, ChevronDown } from "lucide-react";
import {
  proFeatures,
  ultraFeatures,
  teamFeatures,
} from "@/lib/pricing/features";
import DeleteAccountDialog from "./DeleteAccountDialog";

const AccountTab = () => {
  const { subscription } = useGlobalState();
  const [showDeleteAccount, setShowDeleteAccount] = useState(false);

  const currentPlanFeatures =
    subscription === "team" ? teamFeatures : proFeatures;

  const handleCancelSubscription = () => {
    redirectToBillingPortal();
  };

  return (
    <div className="space-y-6 min-h-0">
      {/* Subscription Section */}
      <div className="border-b py-2">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-medium">
              {subscription === "ultra"
                ? "HackerAI Ultra"
                : subscription === "team"
                  ? "HackerAI Team"
                  : subscription === "pro"
                    ? "HackerAI Pro"
                    : "Get HackerAI Pro"}
            </div>
          </div>
          {subscription !== "free" ? (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  Manage
                  <ChevronDown className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem
                  variant="destructive"
                  onClick={handleCancelSubscription}
                >
                  <X className="h-4 w-4" />
                  <span>Cancel subscription</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Button variant="default" size="sm" onClick={redirectToPricing}>
              Upgrade
            </Button>
          )}
        </div>

        <div className="mt-2 rounded-lg bg-transparent px-0">
          <span className="text-sm font-semibold inline-block pb-4">
            {subscription === "ultra"
              ? "Thanks for subscribing to Ultra! Your plan includes everything in Pro, plus:"
              : subscription === "team"
                ? "Thanks for subscribing to Team! Your plan includes:"
                : subscription !== "free"
                  ? "Thanks for subscribing to Pro! Your plan includes:"
                  : "Get everything in Free, and more."}
          </span>
          <ul className="mb-2 flex flex-col gap-5">
            {(subscription === "ultra"
              ? ultraFeatures
              : currentPlanFeatures
            ).map((feature, index) => (
              <li key={index} className="relative">
                <div className="flex justify-start gap-3.5">
                  <feature.icon className="h-5 w-5 shrink-0" />
                  <span className="font-normal">{feature.text}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Payment Section - Only show for Pro users */}
      {subscription !== "free" && (
        <div>
          <div className="space-y-4">
            <div className="flex items-center justify-between py-3">
              <div>
                <div className="font-medium">Payment</div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => redirectToBillingPortal()}
              >
                Manage
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Account Section */}
      <div>
        <div className="flex items-center justify-between py-3">
          <div>
            <div className="font-medium">Delete account</div>
          </div>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setShowDeleteAccount(true)}
            aria-label="Delete account"
          >
            Delete
          </Button>
        </div>
      </div>

      <DeleteAccountDialog
        open={showDeleteAccount}
        onOpenChange={setShowDeleteAccount}
      />
    </div>
  );
};

export { AccountTab };
