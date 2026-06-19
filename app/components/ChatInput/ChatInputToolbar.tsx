"use client";

import { AttachmentButton } from "@/app/components/AttachmentButton";
import { ChatModeSelector } from "./ChatModeSelector";
import { ModelSelector } from "@/app/components/ModelSelector";
import {
  SubmitStopButton,
  type SubmitStopButtonProps,
} from "./SubmitStopButton";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { useAuth } from "@workos-inc/authkit-nextjs/components";

export interface ChatInputToolbarProps extends SubmitStopButtonProps {
  onAttachClick: () => void;
}

export function ChatInputToolbar({
  onAttachClick,
  chatMode,
  ...submitStopProps
}: ChatInputToolbarProps) {
  const { selectedModel, setSelectedModel } = useGlobalState();
  const { user } = useAuth();

  return (
    <div className="px-3 flex gap-2 items-center min-w-0">
      <div className="shrink-0">
        <AttachmentButton onAttachClick={onAttachClick} />
      </div>
      <ChatModeSelector />
      {user ? (
        <ModelSelector
          value={selectedModel}
          onChange={setSelectedModel}
          mode={chatMode}
        />
      ) : null}
      <div className="ml-auto shrink-0 flex items-center gap-2.5">
        <SubmitStopButton {...submitStopProps} chatMode={chatMode} />
      </div>
    </div>
  );
}
