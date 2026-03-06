"use client";

import { DropdownMenuContent } from "@/components/ui/dropdown-menu";
import { MessageSquare, Infinity } from "lucide-react";
import type { SubscriptionTier } from "@/types/chat";
import { ModeOptionItem } from "./ModeOptionItem";

export interface ModeSelectorContentProps {
  onSelectAskMode: () => void;
  onAgentModeClick: () => void;
  subscription: SubscriptionTier;
  isCheckingProPlan: boolean;
  temporaryChatsEnabled: boolean;
}

export function ModeSelectorContent({
  onSelectAskMode,
  onAgentModeClick,
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
        onClick={onSelectAskMode}
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
    </DropdownMenuContent>
  );
}
