"use client";

import { useState } from "react";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { ModeSelectorTrigger, ModeSelectorContent } from "./ModeSelectorMenu";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { redirectToPricing } from "@/app/hooks/usePricingDialog";
import { toast } from "sonner";
import { AgentUpgradeDialog } from "./AgentUpgradeDialog";

export interface ChatModeSelectorProps {
  className?: string;
}

export function ChatModeSelector({ className }: ChatModeSelectorProps) {
  const {
    chatMode,
    selectAskMode,
    selectAgentMode,
    subscription,
    isCheckingProPlan,
    temporaryChatsEnabled,
  } = useGlobalState();
  const [agentUpgradeDialogOpen, setAgentUpgradeDialogOpen] = useState(false);

  const handleAgentModeClick = () => {
    if (temporaryChatsEnabled) {
      toast.info("Agent mode requires chat history", {
        description: "Turn off temporary chat to use Agent mode.",
      });
      return;
    }
    if (subscription !== "free") {
      selectAgentMode();
    } else {
      setAgentUpgradeDialogOpen(true);
    }
  };

  const handleUpgradeClick = () => {
    setAgentUpgradeDialogOpen(false);
    redirectToPricing();
  };

  return (
    <>
      <div
        className={`flex items-center gap-1.5 min-w-0 overflow-hidden ${className ?? ""}`}
      >
        <DropdownMenu>
          <ModeSelectorTrigger chatMode={chatMode} />
          <ModeSelectorContent
            onSelectAskMode={selectAskMode}
            onAgentModeClick={handleAgentModeClick}
            subscription={subscription}
            isCheckingProPlan={isCheckingProPlan}
            temporaryChatsEnabled={temporaryChatsEnabled}
          />
        </DropdownMenu>
      </div>

      <AgentUpgradeDialog
        open={agentUpgradeDialogOpen}
        onOpenChange={setAgentUpgradeDialogOpen}
        onUpgradeClick={handleUpgradeClick}
      />
    </>
  );
}
