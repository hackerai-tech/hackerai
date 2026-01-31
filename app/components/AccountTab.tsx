"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { redirectToPricing } from "@/app/hooks/usePricingDialog";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { usePentestgptMigration } from "@/app/hooks/usePentestgptMigration";
import { X, ChevronDown, Sparkle } from "lucide-react";
import {
  proFeatures,
  proPlusFeatures,
  ultraFeatures,
  teamFeatures,
} from "@/lib/pricing/features";
import DeleteAccountDialog from "./DeleteAccountDialog";
import redirectToBillingPortalAction from "@/lib/actions/billing-portal";

const AccountTab = () => {
  const { subscription, setMigrateFromPentestgptDialogOpen } = useGlobalState();
  const [showDeleteAccount, setShowDeleteAccount] = useState(false);
  const [isTeamAdmin, setIsTeamAdmin] = useState<boolean | null>(null);
  const { isMigrating } = usePentestgptMigration();

  // Fetch admin status for team subscriptions
  useEffect(() => {
    if (subscription === "team") {
      fetch("/api/team/members")
        .then((res) => res.json())
        .then((data) => setIsTeamAdmin(data.isAdmin ?? false))
        .catch(() => setIsTeamAdmin(false));
    }
  }, [subscription]);

  // For individual plans (pro/pro-plus/ultra), user always has billing access
  // For team plans, only admins can manage billing
  const canManageBilling =
    subscription === "pro" ||
    subscription === "pro-plus" ||
    subscription === "ultra" ||
    (subscription === "team" && isTeamAdmin === true);

  const currentPlanFeatures =
    subscription === "team"
      ? teamFeatures
      : subscription === "pro-plus"
        ? proPlusFeatures
        : proFeatures;

  const redirectToBillingPortal = async () => {
    try {
      const url = await redirectToBillingPortalAction();
      if (url) {
        window.location.href = url;
      }
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to open billing portal",
      );
    }
  };

  const handleCancelSubscription = () => {
    redirectToBillingPortal();
  };

  const handleOpenMigrateConfirm = () => {
    if (isMigrating) return;
    setMigrateFromPentestgptDialogOpen(true);
  };

  return (
    <div className="space-y-6 min-h-0">
      <div className="border-b py-2">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-medium">
              {subscription === "ultra"
                ? "HackerAI Ultra"
                : subscription === "team"
                  ? "HackerAI Team"
                  : subscription === "pro-plus"
                    ? "HackerAI Pro+"
                    : subscription === "pro"
                      ? "HackerAI Pro"
                      : "Get HackerAI Pro"}
            </div>
          </div>
          {subscription !== "free" ? (
            canManageBilling ? (
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="outline" size="sm">
                    Manage
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  {(subscription === "pro" || subscription === "pro-plus") && (
                    <>
                      <DropdownMenuItem onClick={redirectToPricing}>
                        <Sparkle className="h-4 w-4" />
                        <span>Upgrade plan</span>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                    </>
                  )}
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={handleCancelSubscription}
                  >
                    <X className="h-4 w-4" />
                    <span>Cancel subscription</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null
          ) : (
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={redirectToPricing}
            >
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
                : subscription === "pro-plus"
                  ? "Thanks for subscribing to Pro+! Your plan includes everything in Pro, plus:"
                  : subscription === "pro"
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
              type="button"
              variant="outline"
              size="sm"
              onClick={handleOpenMigrateConfirm}
              disabled={isMigrating}
            >
              {isMigrating ? "Migrating..." : "Migrate"}
            </Button>
          </div>
        </div>
      )}

      {subscription !== "free" && canManageBilling && (
        <div>
          <div className="space-y-4">
            <div className="flex items-center justify-between py-3">
              <div>
                <div className="font-medium">Payment</div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={redirectToBillingPortal}
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
            type="button"
            data-testid="delete-account-button"
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
