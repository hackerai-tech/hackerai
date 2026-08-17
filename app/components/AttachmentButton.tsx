import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { Plus } from "lucide-react";
import { useGlobalState } from "../contexts/GlobalState";
import { useEffect, useRef, useState } from "react";
import { redirectToPricing } from "../hooks/usePricingDialog";
import { captureUpgradeCtaImpression } from "@/lib/analytics/client";

interface AttachmentButtonProps {
  onAttachClick: () => void;
  disabled?: boolean;
}

export const AttachmentButton = ({
  onAttachClick,
  disabled = false,
}: AttachmentButtonProps) => {
  const { subscription, isCheckingProPlan } = useGlobalState();
  const [popoverOpen, setPopoverOpen] = useState(false);
  const capturedImpressionRef = useRef(false);

  useEffect(() => {
    if (!popoverOpen || capturedImpressionRef.current) return;

    capturedImpressionRef.current = true;
    captureUpgradeCtaImpression({
      surface: "file_attachment_popover",
      source: "file_attachment_gate",
      from_tier: subscription,
      cta_text: "Upgrade now",
    });
  }, [popoverOpen, subscription]);

  const handleClick = () => {
    if (subscription !== "free") {
      onAttachClick();
    } else {
      setPopoverOpen(true);
    }
  };

  const handleUpgradeClick = () => {
    // Close the popover first
    setPopoverOpen(false);
    // Navigate to pricing page
    redirectToPricing({
      surface: "file_attachment_popover",
      source: "file_attachment_gate",
      from_tier: subscription,
      cta_text: "Upgrade now",
    });
  };

  // If user has pro plan or we're checking, show normal tooltip behavior
  if (subscription !== "free" || isCheckingProPlan) {
    return (
      <TooltipPrimitive.Root>
        <TooltipTrigger asChild>
          <Button
            type="button"
            onClick={onAttachClick}
            variant="ghost"
            size="sm"
            className="h-8 w-8 min-w-0 rounded-md p-0 hover:bg-muted/30"
            aria-label="Attach files"
            data-testid="attach-files-button"
            disabled={disabled || isCheckingProPlan}
          >
            <Plus className="size-5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <p>Add files</p>
        </TooltipContent>
      </TooltipPrimitive.Root>
    );
  }

  // If user doesn't have pro plan, show popover with upgrade option
  return (
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          onClick={handleClick}
          variant="ghost"
          size="sm"
          className="h-8 w-8 min-w-0 rounded-md p-0 hover:bg-muted/30"
          aria-label="Attach files"
          data-testid="attach-files-button"
          disabled={disabled}
        >
          <Plus className="size-5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-80 p-4"
        side="top"
        align="start"
        data-testid="file-attach-upgrade-dialog"
      >
        <div className="space-y-3">
          <h3 className="font-semibold text-base">Upgrade plan</h3>
          <p className="text-sm text-muted-foreground">
            Get access to file attachments and more features with Pro
          </p>
          <Button
            onClick={handleUpgradeClick}
            className="w-full"
            data-testid="file-attach-upgrade-button"
          >
            Upgrade now
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
};
