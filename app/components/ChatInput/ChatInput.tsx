"use client";

import { useEffect, useRef } from "react";
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
import { toast } from "sonner";
import { isCodexLocal } from "@/types/chat";
import { NULL_THREAD_DRAFT_ID } from "@/lib/utils/client-storage";
import { SandboxSelector } from "../SandboxSelector";
import { ChatInputTextarea } from "./ChatInputTextarea";
import { ChatInputToolbar } from "./ChatInputToolbar";
import {
  ContextUsageIndicator,
  type ContextUsageData,
} from "../ContextUsageIndicator";
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
  placeholder?: string;
  autoFocus?: boolean;
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
  placeholder,
  autoFocus,
}: ChatInputProps) => {
  const {
    input,
    setInput,
    chatMode,
    setChatMode,
    uploadedFiles,
    isUploadingFiles,
    messageQueue,
    removeQueuedMessage,
    queueBehavior,
    setQueueBehavior,
    sandboxPreference,
    setSandboxPreference,
    selectedModel,
    setSelectedModel,
    subscription,
    isCheckingProPlan,
    temporaryChatsEnabled,
    hasLocalSandbox,
    defaultLocalSandboxPreference,
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
    !isMobile &&
    (subscription !== "free" || isAgentMode(chatMode)) &&
    !!contextUsage;
  const isAgent = isAgentMode(chatMode);

  const draftId = isNewChat ? "new" : chatId || NULL_THREAD_DRAFT_ID;

  // Free agent mode constraints:
  // 1. Requires local sandbox — fall back to ask mode if disconnected
  // 2. Force local sandbox preference (not e2b)
  // 3. Force auto model selection
  const isFreeAgent =
    !isCheckingProPlan && subscription === "free" && isAgentMode(chatMode);

  const prevHasLocalSandboxRef = useRef(hasLocalSandbox);
  useEffect(() => {
    const wasConnected = prevHasLocalSandboxRef.current;
    prevHasLocalSandboxRef.current = hasLocalSandbox;

    if (!isFreeAgent) return;
    // Only show toast on actual disconnect (true → false), not on
    // initial mount or logout where hasLocalSandbox starts as false.
    if (!hasLocalSandbox) {
      setChatMode("ask");
      if (wasConnected) {
        toast.info("Local sandbox disconnected. Switched to Ask mode.", {
          description: "Reconnect your sandbox to use Agent mode.",
          duration: 5000,
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFreeAgent, hasLocalSandbox]);

  useEffect(() => {
    if (!isFreeAgent) return;
    if (
      (!sandboxPreference || sandboxPreference === "e2b") &&
      defaultLocalSandboxPreference
    ) {
      setSandboxPreference(defaultLocalSandboxPreference);
    }
    if (selectedModel !== "auto") {
      setSelectedModel("auto");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFreeAgent]);

  // Fallback to 'ask' mode when temporary chats are enabled (agent modes not allowed)
  useEffect(() => {
    if (temporaryChatsEnabled && isAgentMode(chatMode)) {
      setChatMode("ask");
    }
  }, [temporaryChatsEnabled, chatMode, setChatMode]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const canSubmit =
      (status === "ready" || status === "streaming") &&
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

        {messageQueue.length > 0 && (
          <QueuedMessagesPanel
            messages={messageQueue}
            onSendNow={onSendNow}
            onDelete={removeQueuedMessage}
            isStreaming={status === "streaming"}
            queueBehavior={queueBehavior}
            onQueueBehaviorChange={setQueueBehavior}
          />
        )}

        {/* Sandbox selector for new chats on mobile: shown above input & file upload.
            Once the first message is sent, switches to below-input placement immediately
            (isNewChat doesn't flip until the stream finishes, so we also check hasMessages).
            On desktop, it's shown below the input (order-3).
            Hidden when Codex is selected (it manages its own sandbox). */}
        {isMobile &&
          isNewChat &&
          !hasMessages &&
          isAgentMode(chatMode) &&
          !isCodexLocal(selectedModel) && (
            <div className="flex px-1 pb-2 min-h-9">
              <SandboxSelector
                value={sandboxPreference}
                onChange={setSandboxPreference}
              />
            </div>
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

        <div
          className={`order-2 sm:order-1 flex flex-col gap-3 transition-colors relative bg-input-chat py-3 max-h-[300px] min-w-0 overflow-hidden shadow-[0px_12px_32px_0px_rgba(0,0,0,0.02)] border border-black/8 dark:border-border focus-within:ring-2 focus-within:ring-ring/20 ${uploadedFiles && uploadedFiles.length > 0 ? "rounded-b-[22px] border-t-0" : "rounded-[22px]"}`}
        >
          <ChatInputTextarea
            draftId={draftId}
            chatMode={chatMode}
            onEnterSubmit={handleSubmit}
            minRows={isCentered ? 3 : 1}
            placeholder={placeholder}
            autoFocus={autoFocus}
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
            contextUsage={!isAgent ? contextUsage : undefined}
            showContextIndicator={!isAgent && showContextIndicator}
          />
        </div>

        {/* Sandbox selector below input.
            Desktop centered new chats (no messages yet): absolutely positioned to avoid
            shifting the centered layout.
            Existing chats / after first message sent (all screens): normal flow.
            Mobile new chats with no messages: hidden (uses above-input placement).
            Hidden when Codex is selected (it manages its own sandbox). */}
        {isAgent &&
          (!isMobile || !isNewChat || hasMessages) &&
          !isCodexLocal(selectedModel) && (
            <div
              className={`order-3 flex items-center px-1 pt-2 ${isNewChat && !hasMessages ? "absolute left-4 right-4 top-full" : ""}`}
            >
              <SandboxSelector
                value={sandboxPreference}
                onChange={setSandboxPreference}
              />
              {showContextIndicator && contextUsage && (
                <div className="ml-auto">
                  <ContextUsageIndicator {...contextUsage} />
                </div>
              )}
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
