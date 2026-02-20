"use client";

import { useState } from "react";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { ModeSelectorTrigger, ModeSelectorContent } from "./ModeSelectorMenu";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { redirectToPricing } from "@/app/hooks/usePricingDialog";
import { SandboxSelector } from "@/app/components/SandboxSelector";
import { isAgentMode } from "@/lib/utils/mode-helpers";
import { toast } from "sonner";
import { AgentUpgradeDialog } from "./AgentUpgradeDialog";

export interface ChatModeSelectorProps {
  className?: string;
}

export function ChatModeSelector({ className }: ChatModeSelectorProps) {
  const {
    chatMode,
    setChatMode,
    subscription,
    isCheckingProPlan,
    temporaryChatsEnabled,
    sandboxPreference,
    setSandboxPreference,
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
      setChatMode("agent");
    } else {
      setAgentUpgradeDialogOpen(true);
    }
  };

  const handleAgentLongModeClick = () => {
    if (temporaryChatsEnabled) {
      toast.info("Agent-Long mode requires chat history", {
        description: "Turn off temporary chat to use Agent-Long mode.",
      });
      return;
    }
    if (subscription !== "free") {
      setChatMode("agent-long");
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
            setChatMode={setChatMode}
            onAgentModeClick={handleAgentModeClick}
            onAgentLongModeClick={handleAgentLongModeClick}
            subscription={subscription}
            isCheckingProPlan={isCheckingProPlan}
            temporaryChatsEnabled={temporaryChatsEnabled}
          />
        </DropdownMenu>

        {isAgentMode(chatMode) && (
          <SandboxSelector
            value={sandboxPreference}
            onChange={setSandboxPreference}
          />
        )}
      </div>

      <AgentUpgradeDialog
        open={agentUpgradeDialogOpen}
        onOpenChange={setAgentUpgradeDialogOpen}
        onUpgradeClick={handleUpgradeClick}
      />
    </>
  );
}
