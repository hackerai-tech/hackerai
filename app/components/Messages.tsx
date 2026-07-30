import {
  useState,
  useEffect,
  useLayoutEffect,
  useMemo,
  useCallback,
  Dispatch,
  MutableRefObject,
  RefCallback,
  SetStateAction,
} from "react";
import dynamic from "next/dynamic";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { MessageItem } from "./MessageItem";
import { AgentActivityRow } from "./AgentActivityRow";
import { AgentWorkHeader } from "./AgentWorkHeader";
import { MessageErrorState } from "./MessageErrorState";
import { SummarizationStatusDivider } from "./SummarizationStatusDivider";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { useScrollPreservation } from "@/components/ai-elements/worked-for";
import Loading from "@/components/ui/loading";
import { useFeedback } from "../hooks/useFeedback";
import { useFileUrlCache } from "../hooks/useFileUrlCache";
import { FileUrlCacheProvider } from "../contexts/FileUrlCacheContext";
import {
  findLastAssistantMessageIndex,
  findLastUserMessageIndex,
} from "@/lib/utils/message-utils";
import type { ChatStatus, ChatMessage } from "@/types";
import type { FileDetails } from "@/types/file";
import type { RetryOptions } from "../hooks/useChatHandlers";
import { toast } from "sonner";
import DotsSpinner from "@/components/ui/dots-spinner";
import { hasTextContent } from "@/lib/utils/message-utils";
import { useDataStreamState } from "./DataStreamProvider";
import type { RateLimitWarningData } from "./RateLimitWarning";
import type { SelectedModel } from "@/types";
import {
  deriveChatTimelineRows,
  getChatTimelineRowType,
  type ChatTimelineRow,
} from "./message-timeline-rows";

const AllFilesDialog = dynamic(
  () => import("./AllFilesDialog").then((module) => module.AllFilesDialog),
  {
    ssr: false,
    loading: () => (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
        role="status"
        aria-label="Loading files"
      >
        <div className="rounded-xl border bg-background p-6 shadow-lg">
          <Loading size={6} />
        </div>
      </div>
    ),
  },
);

type StickyElementRef =
  | MutableRefObject<HTMLElement | null>
  | (RefCallback<HTMLElement> & {
      current?: HTMLElement | null;
    });

const getTimelineRowKey = (row: ChatTimelineRow) => row.id;

const setElementRef = (ref: StickyElementRef, element: HTMLElement | null) => {
  if (typeof ref === "function") {
    ref(element);
  } else {
    ref.current = element;
  }
};

interface MessagesProps {
  messages: ChatMessage[];
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  onRegenerate: () => void | Promise<void>;
  onRetry: (options?: RetryOptions) => void | Promise<void>;
  onContinue?: (selectedModelOverride?: SelectedModel) => void;
  onReconnect?: () => void;
  onEditMessage: (
    messageId: string,
    newContent: string,
    remainingFileIds?: string[],
  ) => Promise<void>;
  onBranchMessage?: (messageId: string) => Promise<void>;
  status: ChatStatus;
  error: Error | null;
  scrollRef: StickyElementRef;
  contentRef: StickyElementRef;
  paginationStatus?:
    "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";
  loadMore?: (numItems: number) => void;
  isTemporaryChat?: boolean;
  isMobile?: boolean;
  tempChatFileDetails?: Map<string, FileDetails[]>;
  finishReason?: string;
  uploadStatus?: { message: string; isUploading: boolean } | null;
  summarizationStatus?: {
    status: "started" | "completed";
    message: string;
  } | null;
  mode?: import("@/types").ChatMode;
  agentRunSpendCapWarning?: Extract<
    RateLimitWarningData,
    { warningType: "agent-run-spend-cap" }
  >;
  chatTitle?: string | null;
  branchedFromChatId?: string;
  branchedFromChatTitle?: string;
}

export const Messages = ({
  messages,
  setMessages,
  onRegenerate,
  onRetry,
  onContinue,
  onReconnect,
  onEditMessage,
  onBranchMessage,
  status,
  error,
  scrollRef,
  contentRef,
  paginationStatus,
  loadMore,
  isTemporaryChat,
  isMobile,
  tempChatFileDetails,
  finishReason,
  uploadStatus,
  summarizationStatus,
  mode,
  agentRunSpendCapWarning,
  chatTitle,
  branchedFromChatId,
  branchedFromChatTitle,
}: MessagesProps) => {
  const { isAutoResuming } = useDataStreamState();
  // Prefetch and cache image URLs for better performance
  const { getCachedUrl, setCachedUrl } = useFileUrlCache(messages);

  // Filter out auto-continue messages for rendering
  const visibleMessages = useMemo(
    () => messages.filter((msg) => !msg.metadata?.isAutoContinue),
    [messages],
  );

  // Memoize expensive calculations
  const lastAssistantMessageIndex = useMemo(() => {
    return findLastAssistantMessageIndex(visibleMessages);
  }, [visibleMessages]);

  const lastUserMessageIndex = useMemo(() => {
    return findLastUserMessageIndex(visibleMessages);
  }, [visibleMessages]);
  const lastUserMessageId =
    lastUserMessageIndex === undefined
      ? undefined
      : visibleMessages[lastUserMessageIndex]?.id;

  // Check if last assistant message has any content (text or files)
  const lastAssistantHasContent = useMemo(() => {
    if (lastAssistantMessageIndex === undefined) return false;
    const lastAssistantMsg = visibleMessages[lastAssistantMessageIndex];
    if (!lastAssistantMsg) return false;
    const hasText = hasTextContent(lastAssistantMsg.parts);
    const hasFiles = lastAssistantMsg.parts.some(
      (part) => part.type === "file",
    );
    return hasText || hasFiles;
  }, [lastAssistantMessageIndex, visibleMessages]);

  // Check if we should show loading dots (streaming with no content yet)
  const shouldShowLoadingDots = useMemo(() => {
    // Show dots while resuming an interrupted stream until the first chunk arrives
    if (isAutoResuming) return true;
    if (status !== "streaming" && status !== "submitted") return false;
    if (summarizationStatus?.status === "started") return false;
    if (uploadStatus?.isUploading) return false;

    // Check if last assistant message has text content
    const lastAssistantMsg =
      lastAssistantMessageIndex !== undefined
        ? visibleMessages[lastAssistantMessageIndex]
        : undefined;
    if (!lastAssistantMsg) return true; // No message yet, show dots
    return !hasTextContent(lastAssistantMsg.parts);
  }, [
    isAutoResuming,
    status,
    summarizationStatus,
    uploadStatus,
    lastAssistantMessageIndex,
    visibleMessages,
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

  const [expandedAgentMessageIds, setExpandedAgentMessageIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const timelineRows = useMemo(
    () =>
      deriveChatTimelineRows({
        messages: visibleMessages,
        status,
        lastAssistantMessageIndex,
        expandedAgentMessageIds,
      }),
    [
      expandedAgentMessageIds,
      lastAssistantMessageIndex,
      status,
      visibleMessages,
    ],
  );
  // Track edit state for messages
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);

  // Track all files dialog state
  const [showAllFilesDialog, setShowAllFilesDialog] = useState(false);
  const [hasOpenedAllFilesDialog, setHasOpenedAllFilesDialog] = useState(false);
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
  const handleStartEdit = useCallback(
    (messageId: string) => {
      if (messageId === lastUserMessageId) {
        setEditingMessageId(messageId);
      }
    },
    [lastUserMessageId],
  );

  const handleSaveEdit = useCallback(
    async (newContent: string, remainingFileIds: string[]) => {
      if (editingMessageId && editingMessageId === lastUserMessageId) {
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
    [editingMessageId, lastUserMessageId, onEditMessage],
  );

  const handleCancelEdit = useCallback(() => {
    setEditingMessageId(null);
  }, []);

  // Handler to show all files for a specific message
  const handleShowAllFiles = useCallback(
    (message: ChatMessage, fileDetails: FileDetails[]) => {
      if (!fileDetails || fileDetails.length === 0) return;

      const files = fileDetails
        .filter((file) => file.url || file.fileId || file.s3Key)
        .map((file, fileIndex) => ({
          part: {
            url: file.url ?? undefined,
            fileId: file.fileId,
            s3Key: file.s3Key,
            name: file.name,
            filename: file.name,
            mediaType: file.mediaType,
            size: file.sizeBytes,
            sizeBytes: file.sizeBytes,
          },
          partIndex: fileIndex,
          messageId: message.id,
        }));

      setDialogFiles(files);
      setHasOpenedAllFilesDialog(true);
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
          toast.error("Failed to branch task. Please try again.");
        }
      }
    },
    [onBranchMessage],
  );

  const [timelineInstance, setTimelineInstance] =
    useState<LegendListRef | null>(null);
  const [timelineElements, setTimelineElements] = useState<{
    content: HTMLElement | null;
    scroll: HTMLElement | null;
  }>({ content: null, scroll: null });
  const { captureScrollPosition, preserveScrollPosition } =
    useScrollPreservation();
  const handleToggleAgentWork = useCallback(
    (messageId: string, nextExpanded: boolean) => {
      preserveScrollPosition(() => {
        setExpandedAgentMessageIds((current) => {
          const next = new Set(current);
          if (nextExpanded) {
            next.add(messageId);
          } else {
            next.delete(messageId);
          }
          return next;
        });
      }, nextExpanded);
    },
    [preserveScrollPosition],
  );

  // Keep the established bottom-follow hook connected to LegendList's actual
  // scroll and content elements. LegendList owns row virtualization and
  // measurement; use-stick-to-bottom continues to own the existing composer
  // follow/escape behavior.
  useLayoutEffect(() => {
    const scrollElement = timelineInstance?.getScrollableNode() ?? null;
    const contentElement =
      scrollElement?.querySelector<HTMLElement>(
        ":scope > .legend-list-content-container",
      ) ?? null;

    setTimelineElements((current) =>
      current.scroll === scrollElement && current.content === contentElement
        ? current
        : { content: contentElement, scroll: scrollElement },
    );
  }, [timelineInstance]);

  useLayoutEffect(() => {
    setElementRef(scrollRef, timelineElements.scroll);
    setElementRef(contentRef, timelineElements.content);

    return () => {
      setElementRef(contentRef, null);
      setElementRef(scrollRef, null);
    };
  }, [contentRef, scrollRef, timelineElements]);

  // Handle scroll to load more messages when scrolling to top
  const handleScroll = useCallback(() => {
    const scrollElement = timelineElements.scroll;
    if (!scrollElement || !loadMore || paginationStatus !== "CanLoadMore") {
      return;
    }

    const { scrollTop } = scrollElement;

    // Check if we're near the top (within 100px)
    if (scrollTop < 100) {
      loadMore(28); // Load 28 more messages
    }
  }, [loadMore, paginationStatus, timelineElements.scroll]);

  // Add scroll event listener
  useEffect(() => {
    const scrollElement = timelineElements.scroll;
    if (!scrollElement) return;

    scrollElement.addEventListener("scroll", handleScroll, { passive: true });
    return () => scrollElement.removeEventListener("scroll", handleScroll);
  }, [handleScroll, timelineElements.scroll]);

  const showingLoadingIndicator =
    summarizationStatus?.status === "started" ||
    uploadStatus?.isUploading ||
    shouldShowLoadingDots;

  const renderTimelineRow = useCallback(
    ({ item: row }: { item: ChatTimelineRow }) => {
      const rowClassName =
        row.kind === "agent-work-header"
          ? "pb-2"
          : row.kind === "agent-activity"
            ? "pb-3"
            : "pb-4";

      let content;
      if (row.kind === "agent-work-header") {
        content = (
          <AgentWorkHeader
            canToggle={row.canToggle}
            durationMs={row.durationMs}
            expanded={row.expanded}
            isTiming={row.isTiming}
            messageId={row.message.id}
            onCaptureScroll={captureScrollPosition}
            onToggle={handleToggleAgentWork}
            startedAt={row.startedAt}
          />
        );
      } else if (row.kind === "agent-activity") {
        const effectiveStatus: ChatStatus =
          status === "streaming" &&
          row.messageIndex !== lastAssistantMessageIndex
            ? "ready"
            : status;
        const sharedFileDetails =
          row.message.fileDetails ||
          tempChatFileDetails?.get(row.message.id) ||
          undefined;

        content = (
          <AgentActivityRow
            deferReasoningCollapseUntilParent={
              row.deferReasoningCollapseUntilParent
            }
            isLastMessage={row.isLastMessage}
            keepLatestReasoningOpenDuringStreaming={
              row.keepLatestReasoningOpenDuringStreaming
            }
            message={row.message}
            part={row.part}
            partIndex={row.partIndex}
            sharedFileDetails={sharedFileDetails}
            status={effectiveStatus}
            terminalChunksByToolCallId={row.terminalChunksByToolCallId}
          />
        );
      } else {
        content = (
          <MessageItem
            message={row.message}
            index={row.messageIndex}
            messagesLength={visibleMessages.length}
            lastAssistantMessageIndex={lastAssistantMessageIndex}
            status={status}
            canEdit={row.messageIndex === lastUserMessageIndex}
            isEditing={
              editingMessageId === lastUserMessageId &&
              editingMessageId === row.message.id
            }
            isMobile={isMobile}
            feedbackInputMessageId={feedbackInputMessageId}
            tempChatFileDetails={tempChatFileDetails}
            finishReason={finishReason}
            mode={mode}
            agentRunSpendCapWarning={agentRunSpendCapWarning}
            isTemporaryChat={isTemporaryChat}
            branchedFromChatId={branchedFromChatId}
            branchedFromChatTitle={branchedFromChatTitle}
            branchBoundaryIndex={branchBoundaryIndex}
            onStartEdit={handleStartEdit}
            onSaveEdit={handleSaveEdit}
            onCancelEdit={handleCancelEdit}
            onRegenerate={onRegenerate}
            onContinue={onContinue}
            onBranchMessage={onBranchMessage ? handleBranchMessage : undefined}
            onFeedback={handleFeedback}
            onFeedbackSubmit={handleFeedbackSubmit}
            onFeedbackCancel={handleFeedbackCancel}
            onShowAllFiles={handleShowAllFiles}
            getCachedUrl={getCachedUrl}
            showingLoadingIndicator={showingLoadingIndicator}
            summarizationStatus={summarizationStatus}
            workPresentation={row.workPresentation}
          />
        );
      }

      return (
        <div
          className={`mx-auto w-full max-w-full sm:max-w-[768px] sm:min-w-[390px] ${rowClassName}`}
          data-timeline-row-kind={row.kind}
        >
          {content}
        </div>
      );
    },
    [
      agentRunSpendCapWarning,
      branchBoundaryIndex,
      branchedFromChatId,
      branchedFromChatTitle,
      editingMessageId,
      feedbackInputMessageId,
      finishReason,
      captureScrollPosition,
      getCachedUrl,
      handleBranchMessage,
      handleCancelEdit,
      handleFeedback,
      handleFeedbackCancel,
      handleFeedbackSubmit,
      handleSaveEdit,
      handleShowAllFiles,
      handleStartEdit,
      handleToggleAgentWork,
      isMobile,
      isTemporaryChat,
      lastAssistantMessageIndex,
      lastUserMessageId,
      lastUserMessageIndex,
      mode,
      onBranchMessage,
      onContinue,
      onRegenerate,
      showingLoadingIndicator,
      status,
      summarizationStatus,
      tempChatFileDetails,
      visibleMessages.length,
    ],
  );

  const timelineHeader =
    paginationStatus === "LoadingMore" ? (
      <div className="mx-auto flex w-full max-w-[768px] justify-center pb-4">
        <Loading size={6} />
      </div>
    ) : null;

  const timelineFooter =
    showSummarizationSeparately ||
    uploadStatus?.isUploading ||
    shouldShowLoadingDots ||
    (error && finishReason !== "timeout") ? (
      <div className="mx-auto flex w-full max-w-full flex-col items-start pb-20 sm:max-w-[768px] sm:min-w-[390px]">
        {showSummarizationSeparately && (
          <SummarizationStatusDivider
            status={summarizationStatus?.status}
            message={summarizationStatus?.message}
            className="mb-1 mt-0"
          />
        )}
        {uploadStatus?.isUploading && (
          <Shimmer className="text-sm">{`${uploadStatus.message}...`}</Shimmer>
        )}
        {shouldShowLoadingDots && (
          <div className="inline-flex items-center rounded-lg bg-muted px-3 py-2 text-muted-foreground">
            <DotsSpinner size="sm" variant="primary" />
          </div>
        )}
        {error && finishReason !== "timeout" && (
          <MessageErrorState
            error={error}
            onRetry={onRetry}
            onReconnect={onReconnect}
            mode={mode}
          />
        )}
      </div>
    ) : (
      <div className="h-20" />
    );

  return (
    <FileUrlCacheProvider
      getCachedUrl={getCachedUrl}
      setCachedUrl={setCachedUrl}
    >
      <div className="relative flex-1 min-h-0">
        <LegendList<ChatTimelineRow>
          ref={setTimelineInstance}
          data={timelineRows}
          extraData={editingMessageId}
          keyExtractor={getTimelineRowKey}
          getItemType={getChatTimelineRowType}
          renderItem={renderTimelineRow}
          estimatedItemSize={48}
          recycleItems={false}
          initialScrollAtEnd
          maintainVisibleContentPosition={{ data: true, size: true }}
          style={{ height: "100%", minHeight: 0 }}
          className="h-full min-h-0 overflow-x-hidden"
          contentContainerStyle={{
            paddingTop: 16,
            paddingRight: 16,
            paddingBottom: 0,
            paddingLeft: 16,
          }}
          ListHeaderComponent={timelineHeader}
          ListFooterComponent={timelineFooter}
          data-testid="messages-container"
        />

        {/* All Files Dialog */}
        {hasOpenedAllFilesDialog && (
          <AllFilesDialog
            open={showAllFilesDialog}
            onOpenChange={setShowAllFilesDialog}
            files={dialogFiles}
            chatTitle={chatTitle}
          />
        )}
      </div>
    </FileUrlCacheProvider>
  );
};
