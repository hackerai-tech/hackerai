import {
  useState,
  RefObject,
  useEffect,
  useMemo,
  useCallback,
  Dispatch,
  SetStateAction,
  Fragment,
} from "react";
import { UseChatHelpers } from "@ai-sdk/react";
import { MessageActions } from "./MessageActions";
import { MessagePartHandler } from "./MessagePartHandler";
import { FilePartRenderer } from "./FilePartRenderer";
import { MessageErrorState } from "./MessageErrorState";
import { MessageEditor } from "./MessageEditor";
import { FeedbackInput } from "./FeedbackInput";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { AllFilesDialog } from "./AllFilesDialog";
import { BranchIndicator } from "./BranchIndicator";
import { FinishReasonNotice } from "./FinishReasonNotice";
import DotsSpinner from "@/components/ui/dots-spinner";
import Loading from "@/components/ui/loading";
import { useFeedback } from "../hooks/useFeedback";
import { useFileUrlCache } from "../hooks/useFileUrlCache";
import { FileUrlCacheProvider } from "../contexts/FileUrlCacheContext";
import {
  extractMessageText,
  hasTextContent,
  findLastAssistantMessageIndex,
  extractWebSourcesFromMessage,
} from "@/lib/utils/message-utils";
import type { ChatStatus, ChatMessage } from "@/types";
import type { FileDetails } from "@/types/file";
import { toast } from "sonner";
import { FileSearch } from "lucide-react";

interface MessagesProps {
  messages: ChatMessage[];
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  onRegenerate: () => void;
  onRetry: () => void;
  onEditMessage: (messageId: string, newContent: string) => Promise<void>;
  onBranchMessage?: (messageId: string) => Promise<void>;
  status: ChatStatus;
  error: Error | null;
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  paginationStatus?:
    | "LoadingFirstPage"
    | "CanLoadMore"
    | "LoadingMore"
    | "Exhausted";
  loadMore?: (numItems: number) => void;
  isSwitchingChats?: boolean;
  isTemporaryChat?: boolean;
  tempChatFileDetails?: Map<string, FileDetails[]>;
  finishReason?: string;
  uploadStatus?: { message: string; isUploading: boolean } | null;
  mode?: "ask" | "agent";
  chatTitle?: string | null;
  branchedFromChatId?: string;
  branchedFromChatTitle?: string;
  addToolApprovalResponse?: UseChatHelpers<ChatMessage>["addToolApprovalResponse"];
}

export const Messages = ({
  messages,
  setMessages,
  onRegenerate,
  onRetry,
  onEditMessage,
  onBranchMessage,
  status,
  error,
  scrollRef,
  contentRef,
  paginationStatus,
  loadMore,
  isSwitchingChats,
  isTemporaryChat,
  tempChatFileDetails,
  finishReason,
  uploadStatus,
  mode,
  chatTitle,
  branchedFromChatId,
  branchedFromChatTitle,
  addToolApprovalResponse,
}: MessagesProps) => {
  // Prefetch and cache image URLs for better performance
  const { getCachedUrl, setCachedUrl } = useFileUrlCache(messages);

  // Memoize expensive calculations
  const lastAssistantMessageIndex = useMemo(() => {
    return findLastAssistantMessageIndex(messages);
  }, [messages]);

  // Compute the branch boundary: last message that originated from another chat
  const branchBoundaryIndex = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].sourceMessageId) return i;
    }
    return -1;
  }, [messages]);

  // Track hover state for all messages
  const [hoveredMessageId, setHoveredMessageId] = useState<string | null>(null);

  // Track edit state for messages
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);

  // Track all files dialog state
  const [showAllFilesDialog, setShowAllFilesDialog] = useState(false);
  const [dialogFiles, setDialogFiles] = useState<
    Array<{
      part: any;
      partIndex: number;
      messageId: string;
    }>
  >([]);

  // Handle feedback logic
  const {
    feedbackInputMessageId,
    handleFeedback,
    handleFeedbackSubmit,
    handleFeedbackCancel,
  } = useFeedback({ messages, setMessages });

  // Sidebar auto-open removed - sidebar only opens via manual clicks

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

  // Extract web sources (memoized adapter)
  const extractWebSources = useCallback(
    (message: ChatMessage) => extractWebSourcesFromMessage(message as any),
    [],
  );

  // Handler to show all files for a specific message
  const handleShowAllFiles = useCallback(
    (message: ChatMessage, fileDetails: FileDetails[]) => {
      if (!fileDetails || fileDetails.length === 0) return;

      const files = fileDetails
        .filter((file) => file.url || file.storageId || file.s3Key)
        .map((file, fileIndex) => ({
          part: {
            url: file.url ?? undefined,
            storageId: file.storageId,
            fileId: file.fileId,
            s3Key: file.s3Key,
            name: file.name,
            filename: file.name,
            mediaType: file.mediaType,
          },
          partIndex: fileIndex,
          messageId: message.id,
        }));

      setDialogFiles(files);
      setShowAllFilesDialog(true);
    },
    [],
  );

  // Handler for branching a message
  const handleBranchMessage = useCallback(
    async (messageId: string) => {
      if (onBranchMessage) {
        try {
          await onBranchMessage(messageId);
        } catch (error) {
          console.error("Failed to branch message:", error);
          toast.error("Failed to branch chat. Please try again.");
        }
      }
    },
    [onBranchMessage],
  );

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleScroll]);

  return (
    <FileUrlCacheProvider
      getCachedUrl={getCachedUrl}
      setCachedUrl={setCachedUrl}
    >
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4">
        <div
          ref={contentRef}
          className="mx-auto w-full max-w-full sm:max-w-[768px] sm:min-w-[390px] flex flex-col space-y-4 pb-20"
          data-testid="messages-container"
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
              message.role === "assistant" &&
              index === lastAssistantMessageIndex;
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

            // Check if message contains image content
            const hasFileContent = message.parts.some(
              (part) => part.type === "file",
            );

            const shouldShowLoader =
              isLastAssistantMessage &&
              status === "streaming" &&
              !messageHasTextContent;

            // Merge fileDetails from parallel state for temporary chats
            const effectiveFileDetails = !isUser
              ? message.fileDetails ||
                tempChatFileDetails?.get(message.id) ||
                undefined
              : undefined;

            // Get saved files for assistant messages (include files with url, storageId, or s3Key)
            const savedFiles =
              !isUser &&
              (isLastAssistantMessage ? status !== "streaming" : true) &&
              effectiveFileDetails
                ? effectiveFileDetails.filter(
                    (f) => f.url || f.storageId || f.s3Key,
                  )
                : [];

            // Check if we should show branch indicator after this message
            const shouldShowBranchIndicator = Boolean(
              branchedFromChatId &&
              branchedFromChatTitle &&
              branchBoundaryIndex >= 0 &&
              index === branchBoundaryIndex,
            );

            return (
              <Fragment key={message.id}>
                <div
                  data-testid={isUser ? "user-message" : "assistant-message"}
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
                          data-testid="message-content"
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
                                  addToolApprovalResponse={
                                    addToolApprovalResponse
                                  }
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
                                isLastMessage={index === messages.length - 1}
                                addToolApprovalResponse={
                                  addToolApprovalResponse
                                }
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
                                addToolApprovalResponse={
                                  addToolApprovalResponse
                                }
                              />
                            ))}
                          </div>
                        )}
                    </div>
                  )}

                  {/* Saved files from tools (shown after message content for assistant) */}
                  {!isUser && savedFiles.length > 0 && (
                    <div className="mt-2 flex flex-wrap items-center gap-2 w-full">
                      {savedFiles.length > 2 ? (
                        <>
                          {/* Show only last file when more than 2 */}
                          <FilePartRenderer
                            key={`${message.id}-saved-file-${savedFiles.length - 1}`}
                            part={{
                              url:
                                savedFiles[savedFiles.length - 1].url ??
                                undefined,
                              storageId:
                                savedFiles[savedFiles.length - 1].storageId,
                              fileId: savedFiles[savedFiles.length - 1].fileId,
                              s3Key: savedFiles[savedFiles.length - 1].s3Key,
                              name: savedFiles[savedFiles.length - 1].name,
                              filename: savedFiles[savedFiles.length - 1].name,
                              mediaType:
                                savedFiles[savedFiles.length - 1].mediaType,
                            }}
                            partIndex={savedFiles.length - 1}
                            messageId={message.id}
                            totalFileParts={savedFiles.length}
                          />
                          {/* View all files button */}
                          <button
                            onClick={() =>
                              handleShowAllFiles(
                                message,
                                effectiveFileDetails || [],
                              )
                            }
                            className="h-[55px] ps-4 pe-1.5 w-full max-w-80 min-w-64 flex items-center gap-1.5 rounded-[12px] border-[0.5px] border-border bg-background hover:bg-secondary transition-colors"
                            type="button"
                            aria-label="View all files"
                          >
                            <FileSearch
                              className="w-4 h-4 text-muted-foreground"
                              strokeWidth={2}
                            />
                            <span className="text-sm text-muted-foreground">
                              View all files in this task
                            </span>
                          </button>
                        </>
                      ) : (
                        /* Show all files when 2 or less */
                        savedFiles.map((file, fileIndex) => (
                          <FilePartRenderer
                            key={`${message.id}-saved-file-${fileIndex}`}
                            part={{
                              url: file.url ?? undefined,
                              storageId: file.storageId,
                              fileId: file.fileId,
                              s3Key: file.s3Key,
                              name: file.name,
                              filename: file.name,
                              mediaType: file.mediaType,
                            }}
                            partIndex={fileIndex}
                            messageId={message.id}
                            totalFileParts={savedFiles.length}
                          />
                        ))
                      )}
                    </div>
                  )}

                  {/* Loading state */}
                  {shouldShowLoader && (
                    <div className="mt-1 flex justify-start">
                      <div
                        data-testid="streaming"
                        className="bg-muted text-muted-foreground rounded-lg px-3 py-2 flex items-center space-x-2"
                      >
                        <DotsSpinner size="sm" variant="primary" />
                      </div>
                    </div>
                  )}

                  {/* Finish reason notice under last assistant message */}
                  {isLastAssistantMessage && status !== "streaming" && (
                    <FinishReasonNotice
                      finishReason={finishReason}
                      mode={mode}
                    />
                  )}

                  <MessageActions
                    messageText={messageText}
                    isUser={isUser}
                    isLastAssistantMessage={isLastAssistantMessage}
                    canRegenerate={canRegenerate}
                    onRegenerate={onRegenerate}
                    onEdit={() => handleStartEdit(message.id)}
                    onBranch={
                      !isUser && onBranchMessage
                        ? () => handleBranchMessage(message.id)
                        : undefined
                    }
                    isHovered={isHovered}
                    isEditing={isEditing}
                    status={status}
                    onFeedback={(type) => handleFeedback(message.id, type)}
                    existingFeedback={message.metadata?.feedbackType || null}
                    isAwaitingFeedbackDetails={
                      feedbackInputMessageId === message.id
                    }
                    hasFileContent={hasFileContent}
                    isTemporaryChat={Boolean(isTemporaryChat)}
                    sources={
                      !isUser
                        ? isLastAssistantMessage
                          ? status !== "streaming"
                            ? extractWebSources(message)
                            : []
                          : extractWebSources(message)
                        : []
                    }
                  />

                  {/* Show feedback input for negative feedback */}
                  {feedbackInputMessageId === message.id && (
                    <div className="w-full">
                      <FeedbackInput
                        onSend={handleFeedbackSubmit}
                        onCancel={handleFeedbackCancel}
                      />
                    </div>
                  )}
                </div>

                {/* Branch indicator - show after the branched message */}
                {shouldShowBranchIndicator && (
                  <BranchIndicator
                    branchedFromChatId={branchedFromChatId!}
                    branchedFromChatTitle={branchedFromChatTitle!}
                  />
                )}
              </Fragment>
            );
          })}

          {/* Upload status - shown where assistant response will appear */}
          {uploadStatus?.isUploading && (
            <div className="flex flex-col items-start">
              <Shimmer className="text-sm">
                {`${uploadStatus.message}...`}
              </Shimmer>
            </div>
          )}

          {/* Error state */}
          {error && <MessageErrorState error={error} onRetry={onRetry} />}
        </div>

        {/* All Files Dialog */}
        <AllFilesDialog
          open={showAllFilesDialog}
          onOpenChange={setShowAllFilesDialog}
          files={dialogFiles}
          chatTitle={chatTitle}
        />
      </div>
    </FileUrlCacheProvider>
  );
};
