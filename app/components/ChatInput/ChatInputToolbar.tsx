"use client";

import { AttachmentButton } from "@/app/components/AttachmentButton";
import { ChatModeSelector } from "./ChatModeSelector";
import { ModelSelector } from "@/app/components/ModelSelector";
import { SandboxSelector } from "@/app/components/SandboxSelector";
import {
  SubmitStopButton,
  type SubmitStopButtonProps,
} from "./SubmitStopButton";
import {
  ContextUsageIndicator,
  type ContextUsageData,
} from "@/app/components/ContextUsageIndicator";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { isAgentMode } from "@/lib/utils/mode-helpers";

export interface ChatInputToolbarProps extends SubmitStopButtonProps {
  onAttachClick: () => void;
  contextUsage?: ContextUsageData;
  showContextIndicator?: boolean;
  isNewChat?: boolean;
  isMobile?: boolean;
  hasSavedSandboxType?: boolean;
}

export function ChatInputToolbar({
  onAttachClick,
  contextUsage,
  showContextIndicator = false,
  isNewChat = false,
  isMobile = false,
  hasSavedSandboxType = false,
  chatMode,
  ...submitStopProps
}: ChatInputToolbarProps) {
  const {
    selectedModel,
    setSelectedModel,
    sandboxPreference,
    setSandboxPreference,
  } = useGlobalState();

  return (
    <div className="px-3 flex flex-col min-[560px]:flex-row gap-2 min-w-0">
      {/* Attachment + Agent */}
      <div className="flex gap-2 items-center shrink-0">
        <div className="shrink-0">
          <AttachmentButton onAttachClick={onAttachClick} />
        </div>
        <ChatModeSelector />
      </div>
      {/* Cloud + Auto + Submit: second row on narrow, inline on wide */}
      <div className="flex gap-2 items-center flex-1 min-w-0">
        {isAgentMode(chatMode) && (
          <SandboxSelector
            value={sandboxPreference}
            onChange={setSandboxPreference}
            readOnly={hasSavedSandboxType && !isNewChat}
          />
        )}
        <ModelSelector
          value={selectedModel}
          onChange={setSelectedModel}
          mode={chatMode}
        />
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
    </div>
  );
}
