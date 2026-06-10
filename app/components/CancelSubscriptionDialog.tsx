"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useGlobalState } from "@/app/contexts/GlobalState";
import cancelSubscriptionAction from "@/lib/actions/cancel-subscription";
import { toast } from "sonner";
import { CheckCircle2, Loader2, X as XIcon } from "lucide-react";
import {
  proFeatures,
  proPlusFeatures,
  ultraFeatures,
  teamFeatures,
} from "@/lib/pricing/features";
import type { SubscriptionTier } from "@/types";
import {
  CANCELLATION_REASON_OPTIONS,
  type CancellationReasonCategory,
} from "@/lib/billing/cancellation-reasons";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import {
  PAID_FUNNEL_EVENTS,
  paidFunnelProperties,
} from "@/lib/analytics/paid-funnel";

type CancelSubscriptionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type CancellationResult = {
  currentPeriodEnd?: number;
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
    case "free":
      return [];
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
    case "free":
      return "Free";
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
  const [reasonCategory, setReasonCategory] = useState<
    CancellationReasonCategory | ""
  >("");
  const [reasonDetails, setReasonDetails] = useState("");
  const [showValidation, setShowValidation] = useState(false);
  const [cancellationResult, setCancellationResult] =
    useState<CancellationResult | null>(null);
  const openRef = useRef(open);
  const requestIdRef = useRef(0);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      openRef.current = nextOpen;
      if (!nextOpen) {
        requestIdRef.current += 1;
      }
      onOpenChange(nextOpen);
    },
    [onOpenChange],
  );

  useEffect(() => {
    openRef.current = open;

    if (!open) {
      requestIdRef.current += 1;
      setReasonCategory("");
      setReasonDetails("");
      setShowValidation(false);
      setIsProcessing(false);
      setCancellationResult(null);
      return;
    }

    captureAuthenticatedEvent(
      PAID_FUNNEL_EVENTS.cancellationStarted,
      paidFunnelProperties({
        subscription_tier: subscription,
        surface: "cancel_subscription_dialog",
        source: "account_settings",
      }),
    );
  }, [open, subscription]);

  const handleCancelSubscription = useCallback(async () => {
    const trimmedReasonDetails = reasonDetails.trim();
    if (!reasonCategory || !trimmedReasonDetails) {
      setShowValidation(true);
      return;
    }

    setIsProcessing(true);
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    try {
      const result = await cancelSubscriptionAction({
        cancellationReason: {
          reasonCategory,
          reasonDetails: trimmedReasonDetails,
        },
      });
      if (!openRef.current || requestIdRef.current !== requestId) {
        return;
      }
      setCancellationResult({
        currentPeriodEnd: result.currentPeriodEnd,
      });
      toast.success("Subscription scheduled to cancel");
    } catch (error) {
      if (!openRef.current || requestIdRef.current !== requestId) {
        return;
      }
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to cancel subscription",
      );
    } finally {
      if (openRef.current && requestIdRef.current === requestId) {
        setIsProcessing(false);
      }
    }
  }, [reasonCategory, reasonDetails]);

  const handleReasonCategoryChange = useCallback(
    (value: string) => {
      const nextReasonCategory = value as CancellationReasonCategory;
      setReasonCategory(nextReasonCategory);
      setShowValidation(false);
      captureAuthenticatedEvent(
        PAID_FUNNEL_EVENTS.cancellationReasonSelected,
        paidFunnelProperties({
          subscription_tier: subscription,
          reason_category: nextReasonCategory,
          surface: "cancel_subscription_dialog",
          source: "account_settings",
        }),
      );
    },
    [subscription],
  );

  const features = getFeaturesForTier(subscription);
  const planName = getPlanDisplayName(subscription);
  const detailsMissing = showValidation && !reasonDetails.trim();
  const categoryMissing = showValidation && !reasonCategory;
  const periodEndDate = cancellationResult?.currentPeriodEnd
    ? new Intl.DateTimeFormat(undefined, {
        month: "long",
        day: "numeric",
        year: "numeric",
      }).format(new Date(cancellationResult.currentPeriodEnd))
    : null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
        {cancellationResult ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                Cancellation scheduled
              </DialogTitle>
              <DialogDescription>
                {periodEndDate
                  ? `You'll keep your ${planName} plan until ${periodEndDate}.`
                  : `You'll keep your ${planName} plan until the end of your current billing period.`}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="mt-4">
              <Button
                className="w-full"
                onClick={() => handleOpenChange(false)}
              >
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Before you cancel</DialogTitle>
              <DialogDescription>
                {`If you cancel, you'll keep your ${planName} plan until the end of your current billing period.`}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 mt-2">
              <div className="space-y-2">
                <Label htmlFor="cancellation-reason-category">
                  Main reason
                </Label>
                <Select
                  value={reasonCategory}
                  onValueChange={handleReasonCategoryChange}
                  disabled={isProcessing}
                >
                  <SelectTrigger
                    id="cancellation-reason-category"
                    aria-invalid={categoryMissing}
                  >
                    <SelectValue placeholder="Select a reason" />
                  </SelectTrigger>
                  <SelectContent>
                    {CANCELLATION_REASON_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {categoryMissing ? (
                  <p className="text-xs text-destructive">
                    Please select a main reason.
                  </p>
                ) : null}
              </div>

              <div className="space-y-2">
                <Label htmlFor="cancellation-reason-details">
                  Tell us what happened
                </Label>
                <Textarea
                  id="cancellation-reason-details"
                  value={reasonDetails}
                  onChange={(event) => {
                    setReasonDetails(event.target.value);
                    setShowValidation(false);
                  }}
                  maxLength={2000}
                  disabled={isProcessing}
                  aria-invalid={detailsMissing}
                  placeholder="A short note is required before continuing."
                  className="min-h-24 resize-none"
                />
                {detailsMissing ? (
                  <p className="text-xs text-destructive">
                    Please write a cancellation reason.
                  </p>
                ) : null}
              </div>
            </div>

            <div className="mt-2 text-sm text-muted-foreground">
              {"After that, you'll lose access to:"}
            </div>

            <ul className="space-y-2">
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
                onClick={() => handleOpenChange(false)}
                disabled={isProcessing}
                className="w-full"
              >
                Keep my subscription
              </Button>
              <Button
                variant="destructive"
                onClick={handleCancelSubscription}
                disabled={isProcessing}
                className="w-full"
              >
                {isProcessing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Cancel subscription"
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default CancelSubscriptionDialog;
