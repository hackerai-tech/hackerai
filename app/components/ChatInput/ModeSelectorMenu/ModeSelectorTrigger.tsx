"use client";

import { Button } from "@/components/ui/button";
import { DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { MessageSquare, Infinity, Hourglass, ChevronDown } from "lucide-react";
import type { ChatMode } from "@/types/chat";

const MODE_VARIANT_CLASSES: Record<ChatMode, string> = {
  ask: "bg-muted hover:bg-muted/50",
  agent:
    "bg-red-500/10 text-red-700 hover:bg-red-500/20 dark:bg-red-400/10 dark:text-red-400 dark:hover:bg-red-400/20",
  "agent-long":
    "bg-amber-500/10 text-amber-700 hover:bg-amber-500/20 dark:bg-amber-400/10 dark:text-amber-400 dark:hover:bg-amber-400/20",
};

const baseClasses =
  "h-7 px-2 text-xs font-medium rounded-md focus-visible:ring-1 shrink-0";

export interface ModeSelectorTriggerProps {
  chatMode: ChatMode;
}

export function ModeSelectorTrigger({ chatMode }: ModeSelectorTriggerProps) {
  return (
    <DropdownMenuTrigger asChild>
      <Button
        variant="ghost"
        size="sm"
        data-testid="mode-selector"
        className={`${baseClasses} ${MODE_VARIANT_CLASSES[chatMode]}`}
      >
        {chatMode === "agent" ? (
          <>
            <Infinity className="w-3 h-3 md:mr-1" />
            <span className="hidden md:inline">Agent</span>
          </>
        ) : chatMode === "agent-long" ? (
          <>
            <Hourglass className="w-3 h-3 md:mr-1" />
            <span className="hidden md:inline">Agent Long</span>
          </>
        ) : (
          <>
            <MessageSquare className="w-3 h-3 md:mr-1" />
            <span className="hidden md:inline">Ask</span>
          </>
        )}
        <ChevronDown className="w-3 h-3 ml-1" />
      </Button>
    </DropdownMenuTrigger>
  );
}
