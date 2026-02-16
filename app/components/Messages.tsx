import {
  useState,
  RefObject,
  useEffect,
  useMemo,
  useCallback,
  Dispatch,
  SetStateAction,
} from "react";
import { MessageItem } from "./MessageItem";
import { MessageErrorState } from "./MessageErrorState";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { AllFilesDialog } from "./AllFilesDialog";
import Loading from "@/components/ui/loading";
import { useFeedback } from "../hooks/useFeedback";
import { useFileUrlCache } from "../hooks/useFileUrlCache";
import { FileUrlCacheProvider } from "../contexts/FileUrlCacheContext";
import { findLastAssistantMessageIndex } from "@/lib/utils/message-utils";
import type { ChatStatus, ChatMessage } from "@/types";
import type { FileDetails } from "@/types/file";
import { toast } from "sonner";
import { WandSparkles } from "lucide-react";
import DotsSpinner from "@/components/ui/dots-spinner";
import { hasTextContent } from "@/lib/utils/message-utils";

interface MessagesProps {
  messages: ChatMessage[];
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  onRegenerate: () => void;
  onRetry: () => void;
  onEditMessage: (
    messageId: string,
    newContent: string,
    remainingFileIds?: string[],
  ) => Promise<void>;
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
  isTemporaryChat?: boolean;
  tempChatFileDetails?: Map<string, FileDetails[]>;
  finishReason?: string;
  uploadStatus?: { message: string; isUploading: boolean } | null;
  summarizationStatus?: {
    status: "started" | "completed";
    message: string;
  } | null;
  mode?: "ask" | "agent" | "agent-long";
  chatTitle?: string | null;
  branchedFromChatId?: string;
  branchedFromChatTitle?: string;
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
  isTemporaryChat,
  tempChatFileDetails,
  finishReason,
  uploadStatus,
  summarizationStatus,
  mode,
  chatTitle,
  branchedFromChatId,
  branchedFromChatTitle,
}: MessagesProps) => {
  // Prefetch and cache image URLs for better performance
  const { getCachedUrl, setCachedUrl } = useFileUrlCache(messages);

  // Memoize expensive calculations
  const lastAssistantMessageIndex = useMemo(() => {
    return findLastAssistantMessageIndex(messages);
  }, [messages]);

  // Check if last assistant message has any content (text or files)
  const lastAssistantHasContent = useMemo(() => {
    if (lastAssistantMessageIndex === undefined) return false;
    const lastAssistantMsg = messages[lastAssistantMessageIndex];
    if (!lastAssistantMsg) return false;
    const hasText = hasTextContent(lastAssistantMsg.parts);
    const hasFiles = lastAssistantMsg.parts.some(
      (part) => part.type === "file",
    );
    return hasText || hasFiles;
  }, [lastAssistantMessageIndex, messages]);

  // Check if we should show loading dots (streaming with no content yet)
  const shouldShowLoadingDots = useMemo(() => {
    if (status !== "streaming") return false;
    if (summarizationStatus?.status === "started") return false;
    if (uploadStatus?.isUploading) return false;

    // Check if last assistant message has text content
    const lastAssistantMsg =
      lastAssistantMessageIndex !== undefined
        ? messages[lastAssistantMessageIndex]
        : undefined;
    if (!lastAssistantMsg) return true; // No message yet, show dots
    return !hasTextContent(lastAssistantMsg.parts);
  }, [
    status,
    summarizationStatus,
    uploadStatus,
    lastAssistantMessageIndex,
    messages,
  ]);

  // Determine if summarization status should be shown as a separate element vs inline
  // Upload status and loading dots ALWAYS show separately (they only appear when no content yet)
  // Summarization status shows separately only when last assistant has no content
  const showSummarizationSeparately = useMemo(() => {
    return (
      summarizationStatus?.status === "started" && !lastAssistantHasContent
    );
  }, [summarizationStatus, lastAssistantHasContent]);

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
    async (newContent: string, remainingFileIds: string[]) => {
      if (editingMessageId) {
        try {
          await onEditMessage(editingMessageId, newContent, remainingFileIds);
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

    const { scrollTop } = scrollRef.current;

    // Check if we're near the top (within 100px)
    if (scrollTop < 100) {
      loadMore(28); // Load 28 more messages
    }
  }, [scrollRef, loadMore, paginationStatus]);

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
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto p-4">
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
          {messages.map((message, index) => (
            <MessageItem
              key={message.id}
              message={message}
              index={index}
              messagesLength={messages.length}
              lastAssistantMessageIndex={lastAssistantMessageIndex}
              status={status}
              isHovered={hoveredMessageId === message.id}
              isEditing={editingMessageId === message.id}
              feedbackInputMessageId={feedbackInputMessageId}
              tempChatFileDetails={tempChatFileDetails}
              finishReason={finishReason}
              mode={mode}
              isTemporaryChat={isTemporaryChat}
              branchedFromChatId={branchedFromChatId}
              branchedFromChatTitle={branchedFromChatTitle}
              branchBoundaryIndex={branchBoundaryIndex}
              onMouseEnter={handleMouseEnter}
              onMouseLeave={handleMouseLeave}
              onStartEdit={handleStartEdit}
              onSaveEdit={handleSaveEdit}
              onCancelEdit={handleCancelEdit}
              onRegenerate={onRegenerate}
              onBranchMessage={
                onBranchMessage ? handleBranchMessage : undefined
              }
              onFeedback={handleFeedback}
              onFeedbackSubmit={handleFeedbackSubmit}
              onFeedbackCancel={handleFeedbackCancel}
              onShowAllFiles={handleShowAllFiles}
              getCachedUrl={getCachedUrl}
              showingLoadingIndicator={
                summarizationStatus?.status === "started" ||
                uploadStatus?.isUploading ||
                shouldShowLoadingDots
              }
              summarizationStatus={summarizationStatus}
            />
          ))}

          {/* Processing status - upload/loading dots always separate, summarization only when no content */}
          {(showSummarizationSeparately ||
            uploadStatus?.isUploading ||
            shouldShowLoadingDots) && (
            <div className="flex flex-col items-start">
              {showSummarizationSeparately && (
                <div className="flex items-center gap-2">
                  <WandSparkles className="w-4 h-4 text-muted-foreground" />
                  <Shimmer className="text-sm">
                    {`${summarizationStatus?.message}...`}
                  </Shimmer>
                </div>
              )}
              {uploadStatus?.isUploading && (
                <Shimmer className="text-sm">{`${uploadStatus.message}...`}</Shimmer>
              )}
              {shouldShowLoadingDots && (
                <div className="bg-muted text-muted-foreground rounded-lg px-3 py-2 inline-flex items-center">
                  <DotsSpinner size="sm" variant="primary" />
                </div>
              )}
            </div>
          )}

          {/* Error state - hide if it was a graceful preemptive timeout */}
          {error && finishReason !== "timeout" && (
            <MessageErrorState error={error} onRetry={onRetry} />
          )}
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
