import { UIMessage } from "@ai-sdk/react";
import { useState, RefObject, useEffect, useMemo, useCallback } from "react";
import { MessageActions } from "./MessageActions";
import { MessagePartHandler } from "./MessagePartHandler";
import { MessageErrorState } from "./MessageErrorState";
import { MessageEditor } from "./MessageEditor";
import DotsSpinner from "@/components/ui/dots-spinner";
import { useSidebarAutoOpen } from "../hooks/useSidebarAutoOpen";
import { extractMessageText, hasTextContent, findLastAssistantMessageIndex } from "@/lib/utils/message-utils";
import type { ChatStatus } from "@/types";

interface MessagesProps {
  messages: UIMessage[];
  onRegenerate: () => void;
  onEditMessage: (messageId: string, newContent: string) => void;
  status: ChatStatus;
  error: Error | null;
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  resetSidebarAutoOpen?: RefObject<(() => void) | null>;
}

export const Messages = ({
  messages,
  onRegenerate,
  onEditMessage,
  status,
  error,
  scrollRef,
  contentRef,
  resetSidebarAutoOpen,
}: MessagesProps) => {
  // Memoize expensive calculations
  const lastAssistantMessageIndex = useMemo(() => {
    return findLastAssistantMessageIndex(messages);
  }, [messages]);

  // Track hover state for all messages
  const [hoveredMessageId, setHoveredMessageId] = useState<string | null>(null);

  // Track edit state for messages
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);

  // Handle sidebar auto-opening
  const { resetSidebarFlag } = useSidebarAutoOpen(
    messages,
    lastAssistantMessageIndex,
    status,
  );

  // Expose reset function to parent if provided
  useEffect(() => {
    if (resetSidebarAutoOpen) {
      resetSidebarAutoOpen.current = resetSidebarFlag;
    }
  }, [resetSidebarFlag, resetSidebarAutoOpen]);



  // Memoized edit handlers to prevent unnecessary re-renders
  const handleStartEdit = useCallback((messageId: string) => {
    setEditingMessageId(messageId);
  }, []);

  const handleSaveEdit = useCallback((newContent: string) => {
    if (editingMessageId) {
      onEditMessage(editingMessageId, newContent);
    }
    setEditingMessageId(null);
  }, [editingMessageId, onEditMessage]);

  const handleCancelEdit = useCallback(() => {
    setEditingMessageId(null);
  }, []);

  // Memoized mouse event handlers
  const handleMouseEnter = useCallback((messageId: string) => {
    setHoveredMessageId(messageId);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setHoveredMessageId(null);
  }, []);

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto p-4">
      <div
        ref={contentRef}
        className="mx-auto w-full max-w-full sm:max-w-[768px] sm:min-w-[390px] flex flex-col space-y-4 pb-20"
      >
        {messages.map((message, index) => {
          const isUser = message.role === "user";
          const isHovered = hoveredMessageId === message.id;
          const isLastAssistantMessage =
            message.role === "assistant" && index === lastAssistantMessageIndex;
          const canRegenerate = status === "ready" || status === "error";
          const isEditing = editingMessageId === message.id;

          // Get message text content for editing
          const messageText = extractMessageText(message.parts);
          const messageHasTextContent = hasTextContent(message.parts);

          const shouldShowLoader =
            isLastAssistantMessage && status === "streaming" && !messageHasTextContent;

          return (
            <div
              key={message.id}
              className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}
              onMouseEnter={() => handleMouseEnter(message.id)}
              onMouseLeave={handleMouseLeave}
            >
              {isEditing && isUser ? (
                <div className="w-full">
                  <MessageEditor
                    initialContent={messageText}
                    onSave={handleSaveEdit}
                    onCancel={handleCancelEdit}
                  />
                </div>
              ) : (
                <div
                  className={`${
                    isUser
                      ? "max-w-[80%] bg-secondary rounded-lg px-4 py-3 text-primary-foreground border border-border"
                      : "w-full text-foreground"
                  } overflow-hidden`}
                >
                  <div className="prose space-y-3 max-w-none dark:prose-invert min-w-0 overflow-hidden ">
                    {message.parts.map((part, partIndex) => (
                      <MessagePartHandler
                        key={`${message.id}-${partIndex}`}
                        message={message}
                        part={part}
                        partIndex={partIndex}
                        status={status}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Loading state */}
              {shouldShowLoader && (
                <div className="mt-1 flex justify-start">
                  <div className="bg-muted text-muted-foreground rounded-lg px-3 py-2 flex items-center space-x-2">
                    <DotsSpinner size="sm" variant="primary" />
                  </div>
                </div>
              )}

              <MessageActions
                messageText={messageText}
                isUser={isUser}
                isLastAssistantMessage={isLastAssistantMessage}
                canRegenerate={canRegenerate}
                onRegenerate={onRegenerate}
                onEdit={() => handleStartEdit(message.id)}
                isHovered={isHovered}
                isEditing={isEditing}
                status={status}
              />
            </div>
          );
        })}

        {/* Error state */}
        {error && (
          <MessageErrorState error={error} onRegenerate={onRegenerate} />
        )}
      </div>
    </div>
  );
};
