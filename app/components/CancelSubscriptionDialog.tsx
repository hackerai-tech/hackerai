"use client";

import { useState, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useGlobalState } from "@/app/contexts/GlobalState";
import redirectToBillingPortalAction from "@/lib/actions/billing-portal";
import { toast } from "sonner";
import { Loader2, X as XIcon } from "lucide-react";
import {
  proFeatures,
  proPlusFeatures,
  ultraFeatures,
  teamFeatures,
} from "@/lib/pricing/features";
import type { SubscriptionTier } from "@/types";

type CancelSubscriptionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function getFeaturesForTier(tier: SubscriptionTier) {
  switch (tier) {
    case "ultra":
      return [...proFeatures, ...ultraFeatures];
    case "pro-plus":
      return [...proFeatures, ...proPlusFeatures];
    case "team":
      return [...proFeatures, ...teamFeatures];
    case "pro":
      return proFeatures;
    default:
      return proFeatures;
  }
}

function getPlanDisplayName(tier: SubscriptionTier) {
  switch (tier) {
    case "ultra":
      return "Ultra";
    case "pro-plus":
      return "Pro+";
    case "team":
      return "Team";
    case "pro":
      return "Pro";
    default:
      return "Pro";
  }
}

export const CancelSubscriptionDialog = ({
  open,
  onOpenChange,
}: CancelSubscriptionDialogProps) => {
  const { subscription } = useGlobalState();
  const [isProcessing, setIsProcessing] = useState(false);

  const handleGoToBillingPortal = useCallback(async () => {
    setIsProcessing(true);
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
      setIsProcessing(false);
    }
  }, []);

  const features = getFeaturesForTier(subscription);
  const planName = getPlanDisplayName(subscription);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Before you cancel</DialogTitle>
          <DialogDescription>
            {`If you cancel, you'll keep your ${planName} plan until the end of your current billing period. After that, you'll lose access to:`}
          </DialogDescription>
        </DialogHeader>

        <ul className="space-y-2 mt-2">
          {features.map((feature, index) => (
            <li key={index} className="flex items-start gap-3">
              <XIcon className="h-4 w-4 shrink-0 mt-0.5 text-destructive" />
              <span className="text-sm text-muted-foreground">
                {feature.text}
              </span>
            </li>
          ))}
        </ul>

        <DialogFooter className="mt-4 flex flex-col gap-2 sm:flex-col">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isProcessing}
            className="w-full"
          >
            Keep my subscription
          </Button>
          <Button
            variant="destructive"
            onClick={handleGoToBillingPortal}
            disabled={isProcessing}
            className="w-full"
          >
            {isProcessing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              "Continue to cancel"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default CancelSubscriptionDialog;
