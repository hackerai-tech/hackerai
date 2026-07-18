"use client";

import { useState } from "react";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { ModeSelectorTrigger, ModeSelectorContent } from "./ModeSelectorMenu";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { toast } from "sonner";
import { AgentUpgradeDialog } from "./AgentUpgradeDialog";
import { navigateToAuth, useTauri } from "@/app/hooks/useTauri";

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
    desktopBridgeStatus,
    retryDesktopBridge,
    defaultLocalSandboxPreference,
    sandboxPreference,
    setSandboxPreference,
    selectedModel,
    setSelectedModel,
  } = useGlobalState();
  const { user } = useAuth();
  const { isTauri } = useTauri();
  const [agentUpgradeDialogOpen, setAgentUpgradeDialogOpen] = useState(false);

  const enableLocalAgentMode = () => {
    setChatMode("agent");
    if (
      (sandboxPreference === "e2b" || !sandboxPreference) &&
      defaultLocalSandboxPreference
    ) {
      setSandboxPreference(defaultLocalSandboxPreference);
    }
    if (selectedModel !== "auto") {
      setSelectedModel("auto");
    }
    setAgentUpgradeDialogOpen(false);
  };

  const handleAgentModeClick = () => {
    if (!user) {
      navigateToAuth("/signup", { preferSignInForReturningUser: true });
      return;
    }
    if (temporaryChatsEnabled) {
      toast.info("Agent mode requires task history", {
        description: "Turn off temporary task to use Agent mode.",
      });
      return;
    }
    if (subscription !== "free") {
      setChatMode("agent");
    } else if (hasLocalSandbox) {
      enableLocalAgentMode();
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
          <ModeSelectorTrigger
            chatMode={chatMode}
            isPaid={subscription !== "free"}
          />
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
        isDesktopEnvironment={isTauri}
        desktopBridgeStatus={desktopBridgeStatus}
        onRetryDesktopBridge={retryDesktopBridge}
        onUseConnectedDesktop={enableLocalAgentMode}
      />
    </>
  );
}
