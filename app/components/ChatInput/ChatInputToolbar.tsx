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
  const showChatModeSelector = Boolean(
    user &&
    chatModeAccessResolved &&
    !paidAgentOnlyActive &&
    !freeDesktopAgentOnlyActive,
  );
  const showFreeAskComputerActivation = Boolean(
    chatModeAccessResolved &&
    user &&
    subscription === "free" &&
    chatMode === "ask" &&
    !hasLocalSandbox,
  );

  return (
    <div className="flex min-w-0 shrink-0 items-center gap-1 px-3 min-[360px]:gap-2">
      <div
        className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden min-[360px]:gap-2"
        data-testid="chat-input-toolbar-controls"
      >
        <div className="shrink-0">
          <AttachmentButton
            onAttachClick={onAttachClick}
            disabled={!isOnline}
          />
        </div>
        {user && isAgentMode(chatMode) ? (
          <div
            className="shrink-0 md:hidden"
            data-testid="chat-input-mobile-permission"
          >
            <AgentPermissionSelector analyticsSurface="chat_input" iconOnly />
          </div>
        ) : null}
        {showChatModeSelector ? (
          <ChatModeSelector className="shrink-0" />
        ) : null}
        {showFreeAskComputerActivation ? <FreeAskComputerActivation /> : null}
        {user && isAgentMode(chatMode) ? (
          <>
            <div
              className="hidden shrink-0 md:block"
              data-testid="chat-input-desktop-permission"
            >
              <AgentPermissionSelector analyticsSurface="chat_input" />
            </div>
            <div
              className="hidden min-w-0 md:block"
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
      </div>
      <div
        className="flex shrink-0 items-center gap-1 min-[360px]:gap-2.5"
        data-testid="chat-input-primary-actions"
      >
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
