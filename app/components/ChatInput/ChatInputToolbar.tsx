"use client";

import { AttachmentButton } from "@/app/components/AttachmentButton";
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
import { useHac45AgentOnlyTreatment } from "@/app/contexts/Hac45AgentOnlyContext";

export interface ChatInputToolbarProps extends SubmitStopButtonProps {
  onAttachClick: () => void;
}

export function ChatInputToolbar({
  onAttachClick,
  chatMode,
  ...submitStopProps
}: ChatInputToolbarProps) {
  const { selectedModel, setSelectedModel, subscription } = useGlobalState();
  const { user } = useAuth();
  const hac45AgentOnlyActive = useHac45AgentOnlyTreatment();

  return (
    <div className="px-3 flex gap-2 items-center min-w-0">
      <div className="shrink-0">
        <AttachmentButton onAttachClick={onAttachClick} />
      </div>
      {hac45AgentOnlyActive ? null : <ChatModeSelector />}
      {isAgentMode(chatMode) ? (
        <div className="hidden md:block">
          <AgentPermissionSelector analyticsSurface="chat_input" />
        </div>
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
        />
      </div>
    </div>
  );
}
