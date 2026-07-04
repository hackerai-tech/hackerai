"use client";

import { useState } from "react";
import { Check, ChevronDown, ShieldCheck, ShieldQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useGlobalState } from "@/app/contexts/GlobalState";
import type { AgentPermissionMode } from "@/types";

type AgentPermissionSelectorProps = {
  size?: "sm" | "md";
};

type PermissionOption = {
  id: AgentPermissionMode;
  label: string;
  description: string;
  shortLabel: string;
  icon: typeof ShieldCheck;
};

const options: PermissionOption[] = [
  {
    id: "full_access",
    label: "Full access",
    description: "Run commands and edit files without approval prompts.",
    shortLabel: "Full access",
    icon: ShieldCheck,
  },
  {
    id: "ask_approval",
    label: "Ask for approval",
    description:
      "Pause before commands and file edits so you can approve or deny.",
    shortLabel: "Ask for approval",
    icon: ShieldQuestion,
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
      : "h-7 px-2 gap-1 text-xs font-medium rounded-md bg-transparent hover:bg-muted/30 focus-visible:ring-1 min-w-0 shrink";

  const iconClassName = size === "md" ? "h-4 w-4 shrink-0" : "h-3 w-3 shrink-0";

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
              size === "md" ? "h-4 w-4 ml-1 shrink-0" : "h-3 w-3 ml-1 shrink-0"
            }
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[280px] p-1" align="start">
        <div className="space-y-0.5">
          {options.map((option) => {
            const OptionIcon = option.icon;
            const selected = option.id === agentPermissionMode;
            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={selected}
                onClick={() => {
                  setAgentPermissionMode(option.id);
                  setOpen(false);
                }}
                className={`w-full flex items-start gap-2.5 p-2 rounded-md text-left transition-colors ${
                  selected
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-muted"
                }`}
              >
                <OptionIcon className="h-4 w-4 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">
                    {option.label}
                  </div>
                  <div
                    className={`text-xs leading-snug mt-0.5 ${
                      selected
                        ? "text-accent-foreground/70"
                        : "text-muted-foreground"
                    }`}
                  >
                    {option.description}
                  </div>
                </div>
                {selected && <Check className="h-4 w-4 shrink-0 mt-0.5" />}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
