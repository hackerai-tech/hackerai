"use client";

import { AttachmentButton } from "@/app/components/AttachmentButton";
import { ChatModeSelector } from "./ChatModeSelector";
// import { ModelSelector } from "@/app/components/ModelSelector";
import {
  SubmitStopButton,
  type SubmitStopButtonProps,
} from "./SubmitStopButton";
import {
  ContextUsageIndicator,
  type ContextUsageData,
} from "@/app/components/ContextUsageIndicator";

export interface ChatInputToolbarProps extends SubmitStopButtonProps {
  onAttachClick: () => void;
  contextUsage?: ContextUsageData;
  showContextIndicator?: boolean;
}

export function ChatInputToolbar({
  onAttachClick,
  contextUsage,
  showContextIndicator = false,
  chatMode,
  ...submitStopProps
}: ChatInputToolbarProps) {
  return (
    <div className="px-3 flex gap-2 items-center min-w-0">
      <div className="shrink-0">
        <AttachmentButton onAttachClick={onAttachClick} />
      </div>
      <ChatModeSelector />
      {/* <ModelSelector
        value={selectedModel}
        onChange={setSelectedModel}
        mode={chatMode}
      /> */}
      {showContextIndicator && contextUsage && (
        <div className="shrink-0">
          <ContextUsageIndicator {...contextUsage} />
        </div>
      )}
      <div className="ml-auto shrink-0">
        <SubmitStopButton
          {...submitStopProps}
          chatMode={chatMode}
          showContextIndicator={showContextIndicator}
        />
      </div>
    </div>
  );
}
