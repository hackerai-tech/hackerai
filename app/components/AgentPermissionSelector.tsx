"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  Hand,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { useAgentAutoReviewAvailability } from "@/app/contexts/AgentAutoReviewAvailabilityContext";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import type { AgentPermissionMode } from "@/types";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

type AgentPermissionSelectorProps = {
  size?: "sm" | "md";
  iconOnly?: boolean;
  analyticsSurface: "chat_input" | "agents_tab";
};

type PermissionOption = {
  id: AgentPermissionMode;
  label: string;
  description: string;
  shortLabel: string;
  icon: typeof ShieldAlert;
};

const baseOptions: PermissionOption[] = [
  {
    id: "ask_approval",
    label: "Ask for approval",
    description: "Always ask before commands and file changes.",
    shortLabel: "Ask for approval",
    icon: Hand,
  },
  {
    id: "auto_review",
    label: "Approve for me",
    description: "Only ask for actions detected as potentially unsafe.",
    shortLabel: "Approve for me",
    icon: ShieldCheck,
  },
  {
    id: "full_access",
    label: "Full access",
    description: "Run commands and edit files without asking.",
    shortLabel: "Full access",
    icon: ShieldAlert,
  },
];

export function AgentPermissionSelector({
  size = "sm",
  iconOnly = false,
  analyticsSurface,
}: AgentPermissionSelectorProps) {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const [menuLayout, setMenuLayout] = useState(isMobile);
  // Close before committing a different menu/focus scope at the breakpoint.
  if (menuLayout !== isMobile) {
    setMenuLayout(isMobile);
    setOpen(false);
  }
  const { agentPermissionMode, setAgentPermissionMode } = useGlobalState();
  const { agentAutoReviewAvailable, resolveAgentAutoReviewAvailability } =
    useAgentAutoReviewAvailability();
  useEffect(() => {
    resolveAgentAutoReviewAvailability();
  }, [resolveAgentAutoReviewAvailability]);

  useEffect(() => {
    if (
      agentAutoReviewAvailable === false &&
      agentPermissionMode === "auto_review"
    ) {
      setAgentPermissionMode("ask_approval");
    }
  }, [agentAutoReviewAvailable, agentPermissionMode, setAgentPermissionMode]);

  const showAutoReview =
    agentAutoReviewAvailable === true ||
    (agentAutoReviewAvailable === null &&
      agentPermissionMode === "auto_review");

  const options = useMemo(
    () =>
      showAutoReview
        ? baseOptions
        : baseOptions.filter((option) => option.id !== "auto_review"),
    [showAutoReview],
  );
  const selectedOption =
    options.find((option) => option.id === agentPermissionMode) ?? options[0];
  const Icon = selectedOption.icon;

  const buttonClassName = iconOnly
    ? `h-8 w-8 min-w-0 shrink-0 rounded-md p-0 hover:bg-muted/30 focus-visible:ring-1 ${agentPermissionMode === "full_access" ? "text-orange-600 dark:text-orange-400" : ""}`
    : size === "md"
      ? "h-9 max-w-full px-3 gap-2 text-sm font-medium rounded-md bg-transparent hover:bg-muted/30 focus-visible:ring-1 min-w-0 shrink"
      : "h-8 max-w-full px-2.5 gap-2 text-sm font-medium rounded-md bg-transparent hover:bg-muted/30 focus-visible:ring-1 min-w-0 shrink";

  const iconClassName = iconOnly
    ? "size-5 shrink-0"
    : size === "md"
      ? "h-4 w-4 shrink-0"
      : "h-5 w-5 shrink-0";

  const trigger = (
    <Button
      variant="ghost"
      size={iconOnly ? "icon-sm" : size === "md" ? "default" : "sm"}
      className={buttonClassName}
      aria-label={
        iconOnly ? `Agent permissions: ${selectedOption.label}` : undefined
      }
      title={
        iconOnly ? `Agent permissions: ${selectedOption.label}` : undefined
      }
    >
      <Icon className={iconClassName} aria-hidden="true" />
      {!iconOnly && (
        <>
          <span className="min-w-0 flex-1 truncate">
            {selectedOption.shortLabel}
          </span>
          <ChevronDown
            aria-hidden="true"
            className={
              size === "md"
                ? "h-4 w-4 ml-1 shrink-0"
                : "h-4 w-4 ml-0.5 shrink-0"
            }
          />
        </>
      )}
    </Button>
  );
  const optionList = (
    <div
      className={
        isMobile ? "overflow-hidden rounded-2xl bg-muted/50" : "space-y-1"
      }
    >
      {options.map((option) => {
        const OptionIcon = option.icon;
        const selected = option.id === agentPermissionMode;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={selected}
            onClick={() => {
              if (option.id !== agentPermissionMode) {
                captureAuthenticatedEvent("agent_permission_mode_changed", {
                  mode: "agent",
                  previous_agent_permission_mode: agentPermissionMode,
                  agent_permission_mode: option.id,
                  surface: analyticsSurface,
                  agent_permission_event_version: 1,
                  $set: {
                    agent_permission_mode: option.id,
                    last_agent_permission_mode_changed_at:
                      new Date().toISOString(),
                  },
                });
              }
              setAgentPermissionMode(option.id);
              setOpen(false);
            }}
            className={`flex w-full items-center gap-3 text-left transition-colors ${isMobile ? "min-h-20 px-4 py-4 border-b border-border/60 last:border-b-0" : "rounded-md px-2.5 py-2"} ${
              isMobile && option.id === "full_access"
                ? "text-orange-600 dark:text-orange-400 hover:bg-muted"
                : selected
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-muted"
            }`}
          >
            <OptionIcon
              className={isMobile ? "h-6 w-6 shrink-0" : "h-4 w-4 shrink-0"}
              aria-hidden="true"
            />
            <div className="flex-1 min-w-0">
              <div
                className={
                  isMobile
                    ? "text-base font-medium"
                    : "truncate text-sm font-medium"
                }
              >
                {option.label}
              </div>
              <div
                className={`mt-0.5 text-sm leading-snug ${
                  isMobile && option.id === "full_access"
                    ? "text-orange-600/80 dark:text-orange-400/80"
                    : "text-muted-foreground"
                }`}
              >
                {option.description}
              </div>
            </div>
            {selected && (
              <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
            )}
          </button>
        );
      })}
    </div>
  );

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>{trigger}</SheetTrigger>
        <SheetContent
          data-chat-input-agent-menu
          side="bottom"
          className="max-h-[85dvh] overflow-y-auto rounded-t-[28px] border-black/8 bg-input-chat px-5 pt-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] dark:border-border"
        >
          <SheetTitle className="px-5 text-center text-base leading-snug">
            How should HackerAI actions be approved?
          </SheetTitle>
          <SheetDescription className="sr-only">
            Choose the permissions for Agent actions.
          </SheetDescription>
          {optionList}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        data-chat-input-agent-menu
        className="w-[480px] max-w-[calc(100vw-2rem)] p-3"
        align="start"
      >
        <div className="mb-2 text-sm text-muted-foreground">
          How should HackerAI actions be approved?
        </div>
        {optionList}
      </PopoverContent>
    </Popover>
  );
}
