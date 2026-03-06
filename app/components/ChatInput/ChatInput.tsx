"use client";

import { useGlobalState } from "@/app/contexts/GlobalState";
import { TodoPanel } from "../TodoPanel";
import type { ChatStatus } from "@/types";
import { FileUploadPreview } from "../FileUploadPreview";
import { QueuedMessagesPanel } from "../QueuedMessagesPanel";
import { ScrollToBottomButton } from "../ScrollToBottomButton";
import { useFileUpload } from "@/app/hooks/useFileUpload";
import { removeDraft } from "@/lib/utils/client-storage";
import {
  RateLimitWarning,
  type RateLimitWarningData,
} from "../RateLimitWarning";
import { isAgentMode } from "@/lib/utils/mode-helpers";
import { NULL_THREAD_DRAFT_ID } from "@/lib/utils/client-storage";
import { SandboxSelector } from "../SandboxSelector";
import { ChatInputTextarea } from "./ChatInputTextarea";
import { ChatInputToolbar } from "./ChatInputToolbar";
import type { ContextUsageData } from "../ContextUsageIndicator";
import { useIsMobile } from "@/hooks/use-mobile";

interface ChatInputProps {
  onSubmit: (e: React.FormEvent) => void;
  onStop: () => void;
  onSendNow: (messageId: string) => void;
  status: ChatStatus;
  isCentered?: boolean;
  hasMessages?: boolean;
  isAtBottom?: boolean;
  onScrollToBottom?: () => void;
  hideStop?: boolean;
  isNewChat?: boolean;
  clearDraftOnSubmit?: boolean;
  chatId?: string;
  rateLimitWarning?: RateLimitWarningData;
  onDismissRateLimitWarning?: () => void;
  contextUsage?: ContextUsageData;
  hasSavedSandboxType?: boolean;
}

export const ChatInput = ({
  onSubmit,
  onStop,
  onSendNow,
  status,
  isCentered = false,
  hasMessages = false,
  isAtBottom = true,
  onScrollToBottom,
  hideStop = false,
  isNewChat = false,
  clearDraftOnSubmit = true,
  chatId,
  rateLimitWarning,
  onDismissRateLimitWarning,
  contextUsage,
  hasSavedSandboxType = false,
}: ChatInputProps) => {
  const {
    input,
    setInput,
    chatMode,
    uploadedFiles,
    isUploadingFiles,
    messageQueue,
    removeQueuedMessage,
    queueBehavior,
    setQueueBehavior,
    sandboxPreference,
    setSandboxPreference,
    temporaryChatsEnabled,
  } = useGlobalState();
  const isMobile = useIsMobile();
  const {
    fileInputRef,
    handleFileUploadEvent,
    handleRemoveFile,
    handleAttachClick,
  } = useFileUpload(chatMode);

  const isGenerating = status === "submitted" || status === "streaming";
  const showContextIndicator =
    process.env.NEXT_PUBLIC_ENABLE_CONTEXT_USAGE === "true" &&
    !!contextUsage &&
    contextUsage.maxTokens > 0;

  const draftId = isNewChat ? "new" : chatId || NULL_THREAD_DRAFT_ID;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const canSubmit =
      (status === "ready" ||
        (status === "streaming" && isAgentMode(chatMode))) &&
      !isUploadingFiles &&
      (input.trim() || uploadedFiles.length > 0);

    if (canSubmit) {
      onSubmit(e);
      if (clearDraftOnSubmit) {
        removeDraft(draftId);
        setTimeout(() => setInput(""), 0);
      }
    }
  };

  return (
    <div className={`relative px-4 min-w-0 ${isCentered ? "" : "pb-3"}`}>
      <div className="mx-auto w-full max-w-full min-w-0 sm:max-w-[768px] sm:min-w-[390px] flex flex-col flex-1">
        {rateLimitWarning && onDismissRateLimitWarning && (
          <RateLimitWarning
            data={rateLimitWarning}
            onDismiss={onDismissRateLimitWarning}
          />
        )}

        <TodoPanel status={status} />

        {messageQueue.length > 0 && chatMode === "agent" && (
          <QueuedMessagesPanel
            messages={messageQueue}
            onSendNow={onSendNow}
            onDelete={removeQueuedMessage}
            isStreaming={status === "streaming"}
            queueBehavior={queueBehavior}
            onQueueBehaviorChange={setQueueBehavior}
          />
        )}

        {uploadedFiles && uploadedFiles.length > 0 && (
          <FileUploadPreview
            uploadedFiles={uploadedFiles}
            onRemoveFile={handleRemoveFile}
          />
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="*"
          multiple
          className="hidden"
          aria-label="Upload files"
          onChange={handleFileUploadEvent}
        />

        {/* Sandbox selector for new chats on mobile: shown above input.
            On desktop, it's inside the toolbar like existing chats. */}
        {isNewChat && !temporaryChatsEnabled && !hasMessages && isMobile && (
          <div className="order-1 flex px-1 pb-2 min-h-9">
            {isAgentMode(chatMode) && (
              <SandboxSelector
                value={sandboxPreference}
                onChange={setSandboxPreference}
              />
            )}
          </div>
        )}

        <div
          className={`order-2 sm:order-1 flex flex-col gap-3 transition-colors relative bg-input-chat py-3 max-h-[300px] min-w-0 overflow-hidden shadow-[0px_12px_32px_0px_rgba(0,0,0,0.02)] border border-black/8 dark:border-border focus-within:ring-2 focus-within:ring-ring/20 ${uploadedFiles && uploadedFiles.length > 0 ? "rounded-b-[22px] border-t-0" : "rounded-[22px]"}`}
        >
          <ChatInputTextarea
            draftId={draftId}
            chatMode={chatMode}
            onEnterSubmit={handleSubmit}
          />
          <ChatInputToolbar
            onAttachClick={handleAttachClick}
            isGenerating={isGenerating}
            hideStop={hideStop}
            onStop={onStop}
            onSubmit={handleSubmit}
            status={status}
            isUploadingFiles={isUploadingFiles}
            input={input}
            uploadedFiles={uploadedFiles}
            chatMode={chatMode}
            contextUsage={contextUsage}
            showContextIndicator={showContextIndicator}
            isMobile={isMobile}
            hasSavedSandboxType={hasSavedSandboxType}
          />
        </div>

        {/* ReadOnly sandbox indicator below input (both mobile & desktop).
            Non-readOnly selector below input on mobile only for existing chats.
            Skip rendering entirely when readOnly + cloud to avoid empty padding. */}
        {!isNewChat &&
          isAgentMode(chatMode) &&
          !(hasSavedSandboxType && sandboxPreference === "e2b") &&
          (hasSavedSandboxType || isMobile) && (
            <div className="order-3 flex px-1 pt-2">
              <SandboxSelector
                value={sandboxPreference}
                onChange={setSandboxPreference}
                readOnly={hasSavedSandboxType}
              />
            </div>
          )}

        {onScrollToBottom && (
          <div className="absolute -top-16 left-1/2 -translate-x-1/2 z-40">
            <ScrollToBottomButton
              onClick={onScrollToBottom}
              hasMessages={hasMessages}
              isAtBottom={isAtBottom}
            />
          </div>
        )}
      </div>
    </div>
  );
};
