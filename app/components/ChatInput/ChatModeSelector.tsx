"use client";

import { useState } from "react";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { ModeSelectorTrigger, ModeSelectorContent } from "./ModeSelectorMenu";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { redirectToPricing } from "@/app/hooks/usePricingDialog";
import { toast } from "sonner";
import { AgentUpgradeDialog } from "./AgentUpgradeDialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export interface ChatModeSelectorProps {
  className?: string;
  isStreaming?: boolean;
}

export function ChatModeSelector({
  className,
  isStreaming,
}: ChatModeSelectorProps) {
  const {
    chatMode,
    setChatMode,
    subscription,
    isCheckingProPlan,
    temporaryChatsEnabled,
    agentLongMode,
    setAgentLongMode,
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
            subscription={subscription}
            isCheckingProPlan={isCheckingProPlan}
            temporaryChatsEnabled={temporaryChatsEnabled}
          />
        </DropdownMenu>

        {chatMode === "agent" && (
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => setAgentLongMode(!agentLongMode)}
                  disabled={isStreaming}
                  className={`h-7 px-2 text-xs font-medium rounded-md shrink-0 transition-colors focus-visible:outline-none focus-visible:ring-1 disabled:opacity-50 disabled:cursor-not-allowed ${
                    agentLongMode
                      ? "bg-amber-500/10 text-amber-700 hover:bg-amber-500/20 dark:bg-amber-400/10 dark:text-amber-400 dark:hover:bg-amber-400/20"
                      : "bg-muted/50 text-muted-foreground hover:bg-muted"
                  }`}
                  data-testid="agent-long-toggle"
                >
                  Long
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-xs">
                <p>
                  {agentLongMode
                    ? "Durable execution enabled — agent can run up to 1 hour with automatic checkpoints"
                    : "Enable durable execution for long-running agent tasks"}
                </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
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
