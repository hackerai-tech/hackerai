"use client";

import { AttachmentButton } from "@/app/components/AttachmentButton";
import { SandboxSelector } from "@/app/components/SandboxSelector";
import { ChatModeSelector } from "./ChatModeSelector";
import { ModelSelector } from "@/app/components/ModelSelector";
import { AgentPermissionSelector } from "@/app/components/AgentPermissionSelector";
import {
  SubmitStopButton,
  type SubmitStopButtonProps,
} from "./SubmitStopButton";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { isAgentMode } from "@/lib/utils/mode-helpers";
import { FreeAskComputerActivation } from "./FreeAskComputerActivation";

export interface ChatInputToolbarProps extends SubmitStopButtonProps {
  onAttachClick: () => void;
}

export function ChatInputToolbar({
  onAttachClick,
  chatMode,
  isOnline = true,
  ...submitStopProps
}: ChatInputToolbarProps) {
  const {
    chatModeAccessResolved,
    freeDesktopAgentOnlyActive,
    hasLocalSandbox,
    paidAgentOnlyActive,
    sandboxPreference,
    selectedModel,
    setSandboxPreference,
    setSelectedModel,
    subscription,
  } = useGlobalState();
  const { user } = useAuth();
  const showFreeAskComputerActivation = Boolean(
    chatModeAccessResolved &&
    user &&
    subscription === "free" &&
    chatMode === "ask" &&
    !hasLocalSandbox,
  );

  return (
    <div className="px-3 flex gap-2 items-center min-w-0">
      <div className="shrink-0">
        <AttachmentButton onAttachClick={onAttachClick} disabled={!isOnline} />
      </div>
      {user &&
      chatModeAccessResolved &&
      !paidAgentOnlyActive &&
      !freeDesktopAgentOnlyActive ? (
        <ChatModeSelector />
      ) : null}
      {showFreeAskComputerActivation ? <FreeAskComputerActivation /> : null}
      {isAgentMode(chatMode) ? (
        <>
          <div
            className="hidden md:block"
            data-testid="chat-input-desktop-permission"
          >
            <AgentPermissionSelector analyticsSurface="chat_input" />
          </div>
          <div
            className="hidden md:block"
            data-testid="chat-input-desktop-sandbox"
          >
            <SandboxSelector
              value={sandboxPreference}
              onChange={setSandboxPreference}
              size="toolbar"
            />
          </div>
        </>
      ) : null}
      <div className="ml-auto shrink-0 flex items-center gap-2.5">
        {user ? (
          <ModelSelector
            value={selectedModel}
            onChange={setSelectedModel}
            mode={chatMode}
          />
        ) : null}
        <SubmitStopButton
          {...submitStopProps}
          chatMode={chatMode}
          isPaid={subscription !== "free"}
          useNeutralAgentStyle={freeDesktopAgentOnlyActive}
          isOnline={isOnline}
        />
      </div>
    </div>
  );
}
