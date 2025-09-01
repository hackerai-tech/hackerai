import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { Paperclip } from "lucide-react";
import { useGlobalState } from "../contexts/GlobalState";
import { useUpgrade } from "../hooks/useUpgrade";
import { useState } from "react";

interface AttachmentButtonProps {
  onAttachClick: () => void;
  disabled?: boolean;
}

export const AttachmentButton = ({
  onAttachClick,
  disabled = false,
}: AttachmentButtonProps) => {
  const { hasProPlan, isCheckingProPlan } = useGlobalState();
  const { handleUpgrade, upgradeLoading } = useUpgrade();
  const [popoverOpen, setPopoverOpen] = useState(false);

  const handleClick = () => {
    if (hasProPlan) {
      onAttachClick();
    } else {
      setPopoverOpen(true);
    }
  };

  const handleUpgradeClick = async () => {
    await handleUpgrade();
    // Don't close popover here - let it stay open to show loading state
    // The popover will naturally close when user navigates to Stripe
  };

  // If user has pro plan or we're checking, show normal tooltip behavior
  if (hasProPlan || isCheckingProPlan) {
    return (
      <TooltipPrimitive.Root>
        <TooltipTrigger asChild>
          <Button
            type="button"
            onClick={onAttachClick}
            variant="ghost"
            size="sm"
            className="rounded-full p-0 w-8 h-8 min-w-0"
            aria-label="Attach files"
            disabled={disabled || isCheckingProPlan}
          >
            <Paperclip className="w-[15px] h-[15px]" />
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
          className="rounded-full p-0 w-8 h-8 min-w-0"
          aria-label="Attach files"
          disabled={disabled}
        >
          <Paperclip className="w-[15px] h-[15px]" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-4" side="top" align="start">
        <div className="space-y-3">
          <h3 className="font-semibold text-base">Upgrade to Pro</h3>
          <p className="text-sm text-muted-foreground">
            Get access to file attachments and more features with Pro
          </p>
          <Button
            onClick={handleUpgradeClick}
            disabled={upgradeLoading}
            className="w-full"
          >
            {upgradeLoading ? "Loading..." : "Upgrade now"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
};
