"use client";

import { DropdownMenuContent } from "@/components/ui/dropdown-menu";
import { MessageSquare, Infinity } from "lucide-react";
import type { ChatMode } from "@/types/chat";
import { ModeOptionItem } from "./ModeOptionItem";

export interface ModeSelectorContentProps {
  setChatMode: (mode: ChatMode) => void;
  onAgentModeClick: () => void;
  temporaryChatsEnabled: boolean;
}

export function ModeSelectorContent({
  setChatMode,
  onAgentModeClick,
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
    </DropdownMenuContent>
  );
}
