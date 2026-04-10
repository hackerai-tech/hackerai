"use client";

import { useState } from "react";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { ModeSelectorTrigger, ModeSelectorContent } from "./ModeSelectorMenu";
import { useGlobalState } from "@/app/contexts/GlobalState";
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
    temporaryChatsEnabled,
    hasLocalSandbox,
    defaultLocalSandboxPreference,
    sandboxPreference,
    setSandboxPreference,
    selectedModel,
    setSelectedModel,
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
    } else if (hasLocalSandbox) {
      setChatMode("agent");
      if (sandboxPreference === "e2b" || !sandboxPreference) {
        if (defaultLocalSandboxPreference) {
          setSandboxPreference(defaultLocalSandboxPreference);
        }
      }
      if (selectedModel !== "auto") {
        setSelectedModel("auto");
      }
    } else {
      setAgentUpgradeDialogOpen(true);
    }
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
            temporaryChatsEnabled={temporaryChatsEnabled}
          />
        </DropdownMenu>
      </div>

      <AgentUpgradeDialog
        open={agentUpgradeDialogOpen}
        onOpenChange={setAgentUpgradeDialogOpen}
      />
    </>
  );
}
