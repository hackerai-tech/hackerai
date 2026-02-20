"use client";

import { AttachmentButton } from "@/app/components/AttachmentButton";
import { ChatModeSelector } from "./ChatModeSelector";
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
  ...submitStopProps
}: ChatInputToolbarProps) {
  return (
    <div className="px-3 flex gap-2 items-center">
      <div className="shrink-0">
        <AttachmentButton onAttachClick={onAttachClick} />
      </div>
      <ChatModeSelector />
      {showContextIndicator && contextUsage && (
        <div className="ml-auto">
          <ContextUsageIndicator {...contextUsage} />
        </div>
      )}
      <SubmitStopButton
        {...submitStopProps}
        showContextIndicator={showContextIndicator}
      />
    </div>
  );
}
