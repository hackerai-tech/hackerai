"use client";

import { useState } from "react";
import { Check, ChevronDown, Hand, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import type { AgentPermissionMode } from "@/types";

type AgentPermissionSelectorProps = {
  size?: "sm" | "md";
};

type PermissionOption = {
  id: AgentPermissionMode;
  label: string;
  description: string;
  shortLabel: string;
  icon: typeof ShieldAlert;
};

const options: PermissionOption[] = [
  {
    id: "ask_approval",
    label: "Ask for approval",
    description: "Always ask before running commands and editing files",
    shortLabel: "Ask for approval",
    icon: Hand,
  },
  {
    id: "full_access",
    label: "Full access",
    description: "Run commands and edit files without asking",
    shortLabel: "Full access",
    icon: ShieldAlert,
  },
];

export function AgentPermissionSelector({
  size = "sm",
}: AgentPermissionSelectorProps) {
  const [open, setOpen] = useState(false);
  const { agentPermissionMode, setAgentPermissionMode } = useGlobalState();
  const selectedOption =
    options.find((option) => option.id === agentPermissionMode) ?? options[0];
  const Icon = selectedOption.icon;

  const buttonClassName =
    size === "md"
      ? "h-9 px-3 gap-2 text-sm font-medium rounded-md bg-transparent hover:bg-muted/30 focus-visible:ring-1 min-w-0 shrink"
      : "h-8 px-2.5 gap-2 text-sm font-medium rounded-md bg-transparent hover:bg-muted/30 focus-visible:ring-1 min-w-0 shrink";

  const iconClassName = size === "md" ? "h-4 w-4 shrink-0" : "h-5 w-5 shrink-0";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size={size === "md" ? "default" : "sm"}
          className={buttonClassName}
        >
          <Icon className={iconClassName} />
          <span className="truncate">{selectedOption.shortLabel}</span>
          <ChevronDown
            className={
              size === "md"
                ? "h-4 w-4 ml-1 shrink-0"
                : "h-4 w-4 ml-0.5 shrink-0"
            }
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[480px] max-w-[calc(100vw-2rem)] border-black/8 bg-input-chat p-3 dark:border-border"
        align="start"
      >
        <div className="mb-2 text-sm text-muted-foreground">
          How should HackerAI actions be approved?
        </div>
        <div className="space-y-1">
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
                      surface: "chat_input",
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
                className={`flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors ${
                  selected
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-muted"
                }`}
              >
                <OptionIcon className="h-4 w-4 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="truncate text-sm font-medium">
                    {option.label}
                  </div>
                  <div
                    className={`mt-0.5 text-sm leading-snug ${
                      selected
                        ? "text-accent-foreground/70"
                        : "text-muted-foreground"
                    }`}
                  >
                    {option.description}
                  </div>
                </div>
                {selected && <Check className="h-4 w-4 shrink-0" />}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
