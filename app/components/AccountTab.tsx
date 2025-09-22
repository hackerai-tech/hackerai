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
import { proFeatures, ultraFeatures } from "@/lib/pricing/features";
import DeleteAccountDialog from "./DeleteAccountDialog";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const AccountTab = () => {
  const { subscription } = useGlobalState();
  const [showDeleteAccount, setShowDeleteAccount] = useState(false);
  const [showDeleteChats, setShowDeleteChats] = useState(false);
  const [isDeletingChats, setIsDeletingChats] = useState(false);

  const deleteAllChats = useMutation(api.chats.deleteAllChats);

  const currentPlanFeatures = proFeatures;

  const handleCancelSubscription = () => {
    redirectToBillingPortal();
  };

  const handleDeleteAllChats = async () => {
    if (isDeletingChats) return;
    setIsDeletingChats(true);
    try {
      await deleteAllChats();
    } catch (error) {
      console.error("Failed to delete all chats:", error);
    } finally {
      setShowDeleteChats(false);
      window.location.href = "/";
      setIsDeletingChats(false);
    }
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
              : subscription !== "free"
                ? "Thanks for subscribing to Pro! Your plan includes:"
                : "Get everything in Free, and more."}
          </span>
          {subscription === "ultra" ? (
            <ul className="mb-2 flex flex-col gap-5">
              {ultraFeatures.map((feature, index) => (
                <li key={index} className="relative">
                  <div className="flex justify-start gap-3.5">
                    <feature.icon className="h-5 w-5 shrink-0" />
                    <span className="font-normal">{feature.text}</span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <ul className="mb-2 flex flex-col gap-5">
              {currentPlanFeatures.map((feature, index) => (
                <li key={index} className="relative">
                  <div className="flex justify-start gap-3.5">
                    <feature.icon className="h-5 w-5 shrink-0" />
                    <span className="font-normal">{feature.text}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
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

      {/* Delete All Chats Section */}
      <div>
        <div className="flex items-center justify-between py-3">
          <div>
            <div className="font-medium">Delete all chats</div>
          </div>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setShowDeleteChats(true)}
            aria-label="Delete all chats"
          >
            Delete all
          </Button>
        </div>
      </div>

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

      {/* Delete All Chats Confirmation Dialog */}
      <AlertDialog open={showDeleteChats} onOpenChange={setShowDeleteChats}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Clear your chat history - are you sure?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete all
              your chats and remove all associated data from our servers.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeletingChats}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteAllChats}
              disabled={isDeletingChats}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeletingChats ? "Deleting..." : "Confirm deletion"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export { AccountTab };
