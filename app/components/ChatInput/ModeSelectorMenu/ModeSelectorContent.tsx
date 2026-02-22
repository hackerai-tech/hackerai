"use client";

import { DropdownMenuContent } from "@/components/ui/dropdown-menu";
import { MessageSquare, Infinity, Timer } from "lucide-react";
import type { ChatMode, SubscriptionTier } from "@/types/chat";
import { ModeOptionItem } from "./ModeOptionItem";

export interface ModeSelectorContentProps {
  setChatMode: (mode: ChatMode) => void;
  onAgentModeClick: () => void;
  onAgentLongModeClick: () => void;
  subscription: SubscriptionTier;
  isCheckingProPlan: boolean;
  temporaryChatsEnabled: boolean;
}

export function ModeSelectorContent({
  setChatMode,
  onAgentModeClick,
  onAgentLongModeClick,
  subscription,
  isCheckingProPlan,
  temporaryChatsEnabled,
}: ModeSelectorContentProps) {
  const hasPro = subscription !== "free" || isCheckingProPlan;

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
        showProBadge={!hasPro && !temporaryChatsEnabled}
      />
      <ModeOptionItem
        icon={Timer}
        title="Agent-Long"
        description="Long-running agent tasks"
        onClick={onAgentLongModeClick}
        data-testid="mode-agent-long"
        showLock={temporaryChatsEnabled}
        showProBadge={!hasPro && !temporaryChatsEnabled}
      />
    </DropdownMenuContent>
  );
}
