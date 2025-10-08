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
  const [isMigrating, setIsMigrating] = useState(false);
  const [migrationMessage, setMigrationMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const handleMigratePentestGPT = async () => {
    setIsMigrating(true);
    setMigrationMessage(null);

    try {
      const response = await fetch("/api/migrate-pentestgpt", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      });

      const data = await response.json();

      if (!response.ok) {
        setMigrationMessage({
          type: "error",
          text: data.message || data.error || "Migration failed",
        });
      } else {
        setMigrationMessage({
          type: "success",
          text: "Migration complete. Updating your account...",
        });

        // Trigger entitlement refresh via URL param and optionally open team welcome
        try {
          const url = new URL(window.location.href);
          url.searchParams.set("refresh", "entitlements");
          if (data?.showTeamWelcome) {
            url.searchParams.set("team-welcome", "true");
          }
          window.location.replace(url.toString());
        } catch (error) {
          console.error("Failed to update URL for entitlement refresh:", error);
          // Fallback: hit the entitlements endpoint and reload
          try {
            await fetch("/api/entitlements", { credentials: "include" });
          } catch {}
          window.location.reload();
        }
      }
    } catch (error) {
      setMigrationMessage({
        type: "error",
        text: "An unexpected error occurred during migration",
      });
    } finally {
      setIsMigrating(false);
    }
  };

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

      {/* Migrate from PentestGPT Section - Only show for Free users */}
      {subscription === "free" && (
        <div className="border-b pb-6">
          <div className="flex items-center justify-between py-3">
            <div>
              <div className="font-medium">Migrate from PentestGPT</div>
              <div className="text-sm text-muted-foreground mt-1">
                Transfer your active PentestGPT subscription
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleMigratePentestGPT}
              disabled={isMigrating}
            >
              {isMigrating ? "Migrating..." : "Migrate"}
            </Button>
          </div>
          {migrationMessage && (
            <div
              className={`mt-3 p-3 rounded-md text-sm ${
                migrationMessage.type === "success"
                  ? "bg-green-50 text-green-800 dark:bg-green-900/20 dark:text-green-400"
                  : "bg-red-50 text-red-800 dark:bg-red-900/20 dark:text-red-400"
              }`}
            >
              {migrationMessage.text}
            </div>
          )}
        </div>
      )}

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