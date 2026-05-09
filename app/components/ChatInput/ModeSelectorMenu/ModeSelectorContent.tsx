"use client";

import { DropdownMenuContent } from "@/components/ui/dropdown-menu";
import { MessageSquare, Infinity, Clock } from "lucide-react";
import type { ChatMode } from "@/types/chat";
import { ModeOptionItem } from "./ModeOptionItem";

export interface ModeSelectorContentProps {
  setChatMode: (mode: ChatMode) => void;
  onAgentModeClick: () => void;
  onAgentLongModeClick: () => void;
  temporaryChatsEnabled: boolean;
}

export function ModeSelectorContent({
  setChatMode,
  onAgentModeClick,
  onAgentLongModeClick,
  temporaryChatsEnabled,
}: ModeSelectorContentProps) {
  return (
    <DropdownMenuContent align="start" className="w-54">
      <ModeOptionItem
        icon={MessageSquare}
        title="Ask"
        description="Ask your hacking questions"
        onClick={() => setChatMode("ask")}
        data-testid="mode-ask"
      />
      <ModeOptionItem
        icon={Infinity}
        title="Agent"
        description="Hack, test, secure anything"
        onClick={onAgentModeClick}
        data-testid="mode-agent"
        showLock={temporaryChatsEnabled}
      />
      <ModeOptionItem
        icon={Clock}
        title="Agent Long"
        description="Long-running agent (up to 1h) on trigger.dev"
        onClick={onAgentLongModeClick}
        data-testid="mode-agent-long"
        showLock={temporaryChatsEnabled}
      />
    </DropdownMenuContent>
  );
}
