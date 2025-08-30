import { UIMessage } from "@ai-sdk/react";
import { useState, RefObject, useEffect, useMemo, useCallback } from "react";
import { MessageActions } from "./MessageActions";
import { MessagePartHandler } from "./MessagePartHandler";
import { FilePartRenderer } from "./FilePartRenderer";
import { MessageErrorState } from "./MessageErrorState";
import { MessageEditor } from "./MessageEditor";
import DotsSpinner from "@/components/ui/dots-spinner";
import Loading from "@/components/ui/loading";
import { useSidebarAutoOpen } from "../hooks/useSidebarAutoOpen";
import {
  extractMessageText,
  hasTextContent,
  findLastAssistantMessageIndex,
} from "@/lib/utils/message-utils";
import type { ChatStatus } from "@/types";
import { toast } from "sonner";

interface MessagesProps {
  messages: UIMessage[];
  onRegenerate: () => void;
  onEditMessage: (messageId: string, newContent: string) => Promise<void>;
  status: ChatStatus;
  error: Error | null;
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  resetSidebarAutoOpen?: RefObject<(() => void) | null>;
  paginationStatus?:
    | "LoadingFirstPage"
    | "CanLoadMore"
    | "LoadingMore"
    | "Exhausted";
  loadMore?: (numItems: number) => void;
  isSwitchingChats?: boolean;
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
  paginationStatus,
  loadMore,
  isSwitchingChats,
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

  const handleSaveEdit = useCallback(
    async (newContent: string) => {
      if (editingMessageId) {
        try {
          await onEditMessage(editingMessageId, newContent);
        } catch (error) {
          console.error("Failed to edit message:", error);
          toast.error("Failed to edit message. Please try again.");
        } finally {
          setEditingMessageId(null);
        }
      }
    },
    [editingMessageId, onEditMessage],
  );

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

  // Handle scroll to load more messages when scrolling to top
  const handleScroll = useCallback(() => {
    if (!scrollRef.current || !loadMore || paginationStatus !== "CanLoadMore") {
      return;
    }

    // Don't trigger pagination while switching chats
    if (isSwitchingChats) {
      return;
    }

    const { scrollTop } = scrollRef.current;

    // Check if we're near the top (within 100px)
    if (scrollTop < 100) {
      loadMore(28); // Load 28 more messages
    }
  }, [scrollRef, loadMore, paginationStatus, isSwitchingChats]);

  // Add scroll event listener
  useEffect(() => {
    const scrollElement = scrollRef.current;
    if (!scrollElement) return;

    scrollElement.addEventListener("scroll", handleScroll);
    return () => scrollElement.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto p-4">
      <div
        ref={contentRef}
        className="mx-auto w-full max-w-full sm:max-w-[768px] sm:min-w-[390px] flex flex-col space-y-4 pb-20"
      >
        {/* Loading indicator at top when loading more messages */}
        {paginationStatus === "LoadingMore" && (
          <div className="flex justify-center py-2">
            <Loading size={6} />
          </div>
        )}
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

          // Separate file parts from other parts for user messages
          const fileParts = message.parts.filter(
            (part) => part.type === "file",
          );
          const nonFileParts = message.parts.filter(
            (part) => part.type !== "file",
          );

          const shouldShowLoader =
            isLastAssistantMessage &&
            status === "streaming" &&
            !messageHasTextContent;

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
                      ? "w-full flex flex-col gap-1 items-end"
                      : "w-full text-foreground"
                  } overflow-hidden`}
                >
                  {/* Render file parts first for user messages */}
                  {isUser && fileParts.length > 0 && (
                    <div className="flex flex-wrap items-center justify-end gap-2 w-full">
                      {fileParts.map((part, partIndex) => (
                        <FilePartRenderer
                          key={`${message.id}-file-${partIndex}`}
                          part={part}
                          partIndex={partIndex}
                          messageId={message.id}
                          totalFileParts={fileParts.length}
                        />
                      ))}
                    </div>
                  )}

                  {/* Render text and other parts */}
                  {nonFileParts.length > 0 && (
                    <div
                      className={`${
                        isUser
                          ? "max-w-[80%] bg-secondary rounded-[18px] px-4 py-1.5 data-[multiline]:py-3 rounded-se-lg text-primary-foreground border border-border"
                          : "w-full prose space-y-3 max-w-none dark:prose-invert min-w-0"
                      } overflow-hidden`}
                    >
                      {isUser ? (
                        <div className="whitespace-pre-wrap">
                          {nonFileParts.map((part, partIndex) => (
                            <MessagePartHandler
                              key={`${message.id}-${partIndex}`}
                              message={message}
                              part={part}
                              partIndex={partIndex}
                              status={status}
                            />
                          ))}
                        </div>
                      ) : (
                        // For assistant messages, render all parts in original order
                        message.parts.map((part, partIndex) => (
                          <MessagePartHandler
                            key={`${message.id}-${partIndex}`}
                            message={message}
                            part={part}
                            partIndex={partIndex}
                            status={status}
                          />
                        ))
                      )}
                    </div>
                  )}

                  {/* For assistant messages without the user-specific styling, render files mixed with content */}
                  {!isUser &&
                    fileParts.length > 0 &&
                    nonFileParts.length === 0 && (
                      <div className="prose space-y-3 max-w-none dark:prose-invert min-w-0 overflow-hidden">
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
                    )}
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
