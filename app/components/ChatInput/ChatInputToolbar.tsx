"use client";

import { AttachmentButton } from "@/app/components/AttachmentButton";
import { ChatModeSelector } from "./ChatModeSelector";
import { ModelSelector } from "@/app/components/ModelSelector";
import {
  SubmitStopButton,
  type SubmitStopButtonProps,
} from "./SubmitStopButton";
import {
  ContextUsageIndicator,
  type ContextUsageData,
} from "@/app/components/ContextUsageIndicator";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { isCodexLocal } from "@/types/chat";

export interface ChatInputToolbarProps extends SubmitStopButtonProps {
  onAttachClick: () => void;
  contextUsage?: ContextUsageData;
  showContextIndicator?: boolean;
  hasMessages?: boolean;
}

export function ChatInputToolbar({
  onAttachClick,
  contextUsage,
  showContextIndicator = false,
  chatMode,
  hasMessages = false,
  ...submitStopProps
}: ChatInputToolbarProps) {
  const { selectedModel, setSelectedModel } = useGlobalState();

  // Lock switching away from Codex mid-conversation (but allow sub-model changes)
  const modelLocked = isCodexLocal(selectedModel) && hasMessages;

  return (
    <div className="px-3 flex gap-2 items-center min-w-0">
      <div className="shrink-0">
        <AttachmentButton onAttachClick={onAttachClick} />
      </div>
      <ChatModeSelector />
      <ModelSelector
        value={selectedModel}
        onChange={setSelectedModel}
        mode={chatMode}
        locked={modelLocked}
      />
      <div className="ml-auto shrink-0 flex items-center gap-2.5">
        {showContextIndicator && contextUsage && (
          <ContextUsageIndicator {...contextUsage} />
        )}
        <SubmitStopButton
          {...submitStopProps}
          chatMode={chatMode}
          showContextIndicator={showContextIndicator}
        />
      </div>
    </div>
  );
}
