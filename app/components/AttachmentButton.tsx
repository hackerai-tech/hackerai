import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { Camera, Check, Paperclip, Plus } from "lucide-react";
import { GoalTargetIcon } from "@/components/icons/goal-target";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useGlobalState } from "../contexts/GlobalState";
import { useEffect, useRef, useState } from "react";
import { redirectToPricing } from "../hooks/usePricingDialog";
import {
  captureAuthenticatedEvent,
  captureUpgradeCtaImpression,
} from "@/lib/analytics/client";

export interface AttachmentButtonProps {
  goalMenu?: {
    active: boolean;
    onSelect: () => void;
    onFocusComposer: () => void;
  };
  onAttachClick: (source?: "camera" | "files") => void;
  disabled?: boolean;
}

export const AttachmentButton = ({
  onAttachClick,
  goalMenu,
  disabled = false,
}: AttachmentButtonProps) => {
  const { subscription, isCheckingProPlan } = useGlobalState();
  const [popoverOpen, setPopoverOpen] = useState(false);
  const capturedImpressionRef = useRef(false);
  const goalExposureRef = useRef(false);
  const focusComposerOnCloseRef = useRef(false);

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

  if (goalMenu && subscription !== "free" && !isCheckingProPlan) {
    return (
      <DropdownMenu
        onOpenChange={(open) => {
          if (!open || goalExposureRef.current) return;
          goalExposureRef.current = true;
          captureAuthenticatedEvent("agent_goal_exposed", {
            surface: "composer_plus_menu",
          });
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 w-8 min-w-0 rounded-md p-0 hover:bg-muted/30"
            aria-label="Add files or pursue a goal"
            data-testid="composer-plus-menu-button"
            disabled={disabled}
          >
            <Plus className="size-5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          className="w-60 rounded-2xl p-2"
          data-chat-input-agent-menu
          onCloseAutoFocus={(event) => {
            if (!focusComposerOnCloseRef.current) return;
            focusComposerOnCloseRef.current = false;
            event.preventDefault();
            goalMenu.onFocusComposer();
          }}
        >
          <DropdownMenuItem
            className="min-h-12 gap-3 rounded-xl px-3 text-base"
            onSelect={() => onAttachClick("camera")}
          >
            <span className="flex size-9 items-center justify-center rounded-full bg-muted">
              <Camera className="size-5" />
            </span>
            Camera
          </DropdownMenuItem>
          <DropdownMenuItem
            className="min-h-12 gap-3 rounded-xl px-3 text-base"
            onSelect={() => onAttachClick("files")}
          >
            <span className="flex size-9 items-center justify-center rounded-full bg-muted">
              <Paperclip className="size-5" />
            </span>
            Photos &amp; files
          </DropdownMenuItem>
          <DropdownMenuItem
            className="min-h-12 gap-3 rounded-xl px-3 text-base"
            onSelect={() => {
              focusComposerOnCloseRef.current = true;
              if (!goalMenu.active) {
                captureAuthenticatedEvent("agent_goal_selected", {
                  surface: "composer_plus_menu",
                });
                goalMenu.onSelect();
              }
              // Keep focus in the tap gesture for mobile software keyboards.
              goalMenu.onFocusComposer();
            }}
          >
            <span className="flex size-9 items-center justify-center rounded-full bg-muted">
              <GoalTargetIcon className="size-5" />
            </span>
            Pursue goal
            {goalMenu.active && (
              <>
                <Check className="ml-auto size-4" aria-hidden="true" />
                <span className="sr-only">, on</span>
              </>
            )}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  // If user has pro plan or we're checking, show normal tooltip behavior
  if (subscription !== "free" || isCheckingProPlan) {
    return (
      <TooltipPrimitive.Root>
        <TooltipTrigger asChild>
          <Button
            type="button"
            onClick={() => onAttachClick()}
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
