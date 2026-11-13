import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { BookOpen, Camera, Check, Paperclip, Plus } from "lucide-react";
import { GoalTargetIcon } from "@/components/icons/goal-target";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useGlobalState } from "../contexts/GlobalState";
import { useEffect, useId, useRef, useState } from "react";
import { redirectToPricing } from "../hooks/usePricingDialog";
import {
  captureAuthenticatedEvent,
  captureUpgradeCtaImpression,
} from "@/lib/analytics/client";

export interface AttachmentButtonProps {
  onMenuOpen?: () => void;
  skillsMenu?: {
    layout: "desktop" | "mobile";
    disabled: boolean;
    onSelect: () => void;
  };
  goalMenu?: {
    active: boolean;
    layout: "desktop" | "mobile";
    hasDraft?: boolean;
    hasAttachments?: boolean;
    onSelect: () => void;
    onFocusComposer: () => void;
  };
  onAttachClick: (source?: "camera" | "files") => void;
  disabled?: boolean;
}

export const AttachmentButton = ({
  onAttachClick,
  onMenuOpen,
  goalMenu,
  skillsMenu,
  disabled = false,
}: AttachmentButtonProps) => {
  const { subscription, isCheckingProPlan } = useGlobalState();
  const [popoverOpen, setPopoverOpen] = useState(false);
  const capturedImpressionRef = useRef(false);
  const goalExposureRef = useRef(new Set<string>());
  const selectedMenuItemRef = useRef<
    "camera" | "files" | "skills" | "goal" | null
  >(null);
  const focusComposerOnCloseRef = useRef(false);
  const goalLabelId = useId();
  const goalDescriptionId = useId();

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

  const upgradePanel = (
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
  );

  const showGoalMenu =
    !!goalMenu && subscription !== "free" && !isCheckingProPlan;
  if (showGoalMenu || skillsMenu) {
    const layout = skillsMenu?.layout ?? goalMenu!.layout;
    const mobile = layout === "mobile";
    const analytics = {
      surface: "composer_plus_menu",
      composer_layout: layout,
      goal_ui_version: 2,
      goal_mode_active: goalMenu?.active ?? false,
      has_draft: goalMenu?.hasDraft ?? false,
      has_attachments: goalMenu?.hasAttachments ?? false,
    };
    const selectItem = (item: "camera" | "files" | "skills" | "goal") => {
      selectedMenuItemRef.current = item;
      captureAuthenticatedEvent("composer_plus_menu_action", {
        ...analytics,
        action: item,
      });
    };
    const rowClass = mobile
      ? "min-h-12 gap-3 rounded-xl px-3 text-base"
      : "min-h-9 gap-2.5 rounded-lg px-2.5 py-2 text-sm";
    const iconClass = mobile
      ? "flex size-9 shrink-0 items-center justify-center rounded-full bg-muted"
      : "flex size-4 shrink-0 items-center justify-center text-muted-foreground";
    return (
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <DropdownMenu
          onOpenChange={(open) => {
            if (open) {
              onMenuOpen?.();
              selectedMenuItemRef.current = null;
              captureAuthenticatedEvent("composer_plus_menu_action", {
                ...analytics,
                action: "opened",
              });
              if (showGoalMenu && !goalExposureRef.current.has(layout)) {
                goalExposureRef.current.add(layout);
                captureAuthenticatedEvent("agent_goal_exposed", analytics);
              }
            } else if (selectedMenuItemRef.current === null) {
              captureAuthenticatedEvent("composer_plus_menu_action", {
                ...analytics,
                action: "dismissed",
              });
            }
          }}
        >
          <DropdownMenuTrigger asChild>
            <PopoverAnchor asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 w-8 min-w-0 rounded-md p-0 hover:bg-muted/30"
                aria-label={
                  skillsMenu
                    ? showGoalMenu
                      ? "Add files, skills, or pursue a goal"
                      : "Add files or skills"
                    : "Add files or pursue a goal"
                }
                data-testid="composer-plus-menu-button"
                disabled={disabled}
              >
                <Plus className="size-5" />
              </Button>
            </PopoverAnchor>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="top"
            align="start"
            sideOffset={8}
            collisionPadding={12}
            className={mobile ? "w-60 rounded-2xl p-2" : "w-72 rounded-xl p-1"}
            data-chat-input-agent-menu
            onCloseAutoFocus={(event) => {
              if (
                selectedMenuItemRef.current === "files" &&
                subscription === "free"
              ) {
                event.preventDefault();
                setPopoverOpen(true);
                return;
              }
              if (selectedMenuItemRef.current === "skills") {
                selectedMenuItemRef.current = null;
                event.preventDefault();
                skillsMenu?.onSelect();
                return;
              }
              if (!focusComposerOnCloseRef.current) return;
              focusComposerOnCloseRef.current = false;
              event.preventDefault();
              goalMenu?.onFocusComposer();
            }}
          >
            {mobile && (
              <DropdownMenuItem
                className={rowClass}
                disabled={isCheckingProPlan}
                onSelect={() => {
                  selectItem("camera");
                  if (subscription === "free") {
                    selectedMenuItemRef.current = "files";
                  } else onAttachClick("camera");
                }}
              >
                <span className={iconClass}>
                  <Camera className="size-5" />
                </span>
                Camera
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              className={rowClass}
              disabled={isCheckingProPlan}
              onSelect={() => {
                selectItem("files");
                focusComposerOnCloseRef.current = !mobile;
                if (subscription !== "free") onAttachClick("files");
              }}
            >
              <span className={iconClass}>
                <Paperclip className={mobile ? "size-5" : "size-4"} />
              </span>
              {mobile ? "Photos & files" : "Add photos & files"}
            </DropdownMenuItem>
            {!mobile && <DropdownMenuSeparator />}
            {skillsMenu && (
              <DropdownMenuItem
                className={rowClass}
                disabled={skillsMenu.disabled}
                onSelect={() => selectItem("skills")}
              >
                <span className={iconClass}>
                  <BookOpen className={mobile ? "size-5" : "size-4"} />
                </span>
                Skills
              </DropdownMenuItem>
            )}
            {showGoalMenu && goalMenu && (
              <DropdownMenuItem
                className={rowClass}
                aria-labelledby={mobile ? undefined : goalLabelId}
                aria-describedby={mobile ? undefined : goalDescriptionId}
                onSelect={() => {
                  selectItem("goal");
                  focusComposerOnCloseRef.current = true;
                  if (!goalMenu.active) {
                    captureAuthenticatedEvent("agent_goal_selected", analytics);
                    goalMenu.onSelect();
                  }
                  // Preserve the synchronous mobile keyboard focus path.
                  goalMenu.onFocusComposer();
                }}
              >
                <span className={iconClass}>
                  <GoalTargetIcon className={mobile ? "size-5" : "size-4"} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span id={goalLabelId}>
                      Pursue goal
                      {goalMenu.active && <span className="sr-only">, on</span>}
                    </span>
                    {!mobile && (
                      <span
                        aria-hidden="true"
                        className="ml-auto text-xs text-muted-foreground"
                      >
                        /goal
                      </span>
                    )}
                  </span>
                  {!mobile && (
                    <span
                      id={goalDescriptionId}
                      className="mt-0.5 block text-xs leading-relaxed text-muted-foreground"
                    >
                      Let Agent keep working toward a result.
                    </span>
                  )}
                </span>
                {goalMenu.active && (
                  <>
                    <Check
                      className="ml-auto size-4 shrink-0"
                      aria-hidden="true"
                    />
                  </>
                )}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        {subscription === "free" && upgradePanel}
      </Popover>
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
      {upgradePanel}
    </Popover>
  );
};
