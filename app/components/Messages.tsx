import {
  useState,
  useEffect,
  useLayoutEffect,
  useMemo,
  useCallback,
  useRef,
  useSyncExternalStore,
  Dispatch,
  MutableRefObject,
  RefCallback,
  SetStateAction,
} from "react";
import dynamic from "next/dynamic";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { MessageItem } from "./MessageItem";
import { AgentActivityRow } from "./AgentActivityRow";
import { AgentToolGroupRow } from "./AgentToolGroupRow";
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
import { STICKY_BOTTOM_ESCAPE_EVENT } from "@/lib/utils/scroll-events";
import { MessageNavigator } from "./MessageNavigator";
import { deriveMessageNavigatorItems } from "./message-navigator";
import {
  createStableChatTimelineRowsState,
  deriveChatTimelineRows,
  findMessageTimelineAnchorIndex,
  getChatTimelineRowType,
  stabilizeChatTimelineRows,
  type ChatTimelineRow,
  type StableChatTimelineRowsState,
} from "./message-timeline-rows";
import { CHAT_TIMELINE_ANCHOR_OFFSET } from "../hooks/useMessageScroll";

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

type ToolGroupMountSnapshot = {
  awaitingRestoredAgentMessage: boolean;
  chatId: string;
  hasCommittedTimeline: boolean;
  isRestoringStream: boolean;
  restoredAgentMessageIds: ReadonlySet<string>;
  seenAgentMessageIds: ReadonlySet<string>;
  seenToolGroupIds: ReadonlySet<string>;
};

type ToolGroupMountStore = {
  commit: (
    chatId: string,
    rows: readonly ChatTimelineRow[],
    isRestoringStream: boolean,
  ) => void;
  getSnapshot: () => ToolGroupMountSnapshot;
  markToolGroupMounted: (chatId: string, rowId: string) => void;
  subscribe: (listener: () => void) => () => void;
};

function createToolGroupMountStore(initialChatId: string): ToolGroupMountStore {
  let snapshot: ToolGroupMountSnapshot = {
    awaitingRestoredAgentMessage: false,
    chatId: initialChatId,
    hasCommittedTimeline: false,
    isRestoringStream: false,
    restoredAgentMessageIds: new Set(),
    seenAgentMessageIds: new Set(),
    seenToolGroupIds: new Set(),
  };
  const listeners = new Set<() => void>();

  return {
    commit(chatId, rows, isRestoringStream) {
      const isCurrentChat = snapshot.chatId === chatId;
      let awaitingRestoredAgentMessage = isCurrentChat
        ? snapshot.awaitingRestoredAgentMessage
        : false;
      const previouslySeenAgentMessageIds = isCurrentChat
        ? snapshot.seenAgentMessageIds
        : new Set<string>();
      const restoredAgentMessageIds = isCurrentChat
        ? new Set(snapshot.restoredAgentMessageIds)
        : new Set<string>();
      const seenAgentMessageIds = isCurrentChat
        ? new Set(snapshot.seenAgentMessageIds)
        : new Set<string>();
      const seenToolGroupIds = isCurrentChat
        ? new Set(snapshot.seenToolGroupIds)
        : new Set<string>();
      let changed = !isCurrentChat;

      if (
        isRestoringStream &&
        (!isCurrentChat || !snapshot.isRestoringStream)
      ) {
        awaitingRestoredAgentMessage = true;
        changed = true;
      }
      if (!isCurrentChat || snapshot.isRestoringStream !== isRestoringStream) {
        changed = true;
      }

      const latestMessage = rows.at(-1)?.message;
      const latestIsAgentMessage =
        latestMessage?.role === "assistant" &&
        latestMessage.metadata?.mode === "agent";
      if (awaitingRestoredAgentMessage && latestIsAgentMessage) {
        if (!restoredAgentMessageIds.has(latestMessage.id)) {
          restoredAgentMessageIds.add(latestMessage.id);
          changed = true;
        }
        awaitingRestoredAgentMessage = false;
      }

      for (const row of rows) {
        const isAgentMessage =
          row.message.role === "assistant" &&
          row.message.metadata?.mode === "agent";
        const wasAgentMessageSeen =
          isAgentMessage && previouslySeenAgentMessageIds.has(row.message.id);

        if (isAgentMessage && !seenAgentMessageIds.has(row.message.id)) {
          seenAgentMessageIds.add(row.message.id);
          changed = true;
        }
        if (
          row.kind === "agent-tool-group" &&
          !wasAgentMessageSeen &&
          !seenToolGroupIds.has(row.id)
        ) {
          seenToolGroupIds.add(row.id);
          changed = true;
        }
      }

      const hasCommittedTimeline =
        (isCurrentChat && snapshot.hasCommittedTimeline) || rows.length > 0;
      if (hasCommittedTimeline !== snapshot.hasCommittedTimeline) {
        changed = true;
      }
      if (!changed) return;

      snapshot = {
        awaitingRestoredAgentMessage,
        chatId,
        hasCommittedTimeline,
        isRestoringStream,
        restoredAgentMessageIds,
        seenAgentMessageIds,
        seenToolGroupIds,
      };
      listeners.forEach((listener) => listener());
    },
    getSnapshot: () => snapshot,
    markToolGroupMounted(chatId, rowId) {
      if (snapshot.chatId !== chatId || snapshot.seenToolGroupIds.has(rowId)) {
        return;
      }

      snapshot = {
        ...snapshot,
        seenToolGroupIds: new Set(snapshot.seenToolGroupIds).add(rowId),
      };
      listeners.forEach((listener) => listener());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const setElementRef = (ref: StickyElementRef, element: HTMLElement | null) => {
  if (typeof ref === "function") {
    ref(element);
  } else {
    ref.current = element;
  }
};

interface MessagesProps {
  chatId: string;
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
  anchorMessageId?: string | null;
  contentInsetEndAdjustment?: number;
}

export const Messages = ({
  chatId,
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
  anchorMessageId = null,
  contentInsetEndAdjustment = 0,
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
  const [toolGroupMountStore] = useState(() =>
    createToolGroupMountStore(chatId),
  );
  const toolGroupMountState = useSyncExternalStore(
    toolGroupMountStore.subscribe,
    toolGroupMountStore.getSnapshot,
    toolGroupMountStore.getSnapshot,
  );
  const rawTimelineRows = useMemo(() => {
    const isCurrentChat = toolGroupMountState.chatId === chatId;
    const restoredAgentMessageIds = isCurrentChat
      ? new Set(toolGroupMountState.restoredAgentMessageIds)
      : new Set<string>();
    if (
      isCurrentChat &&
      (isAutoResuming || toolGroupMountState.awaitingRestoredAgentMessage)
    ) {
      const latestMessage = visibleMessages.at(-1);
      if (
        latestMessage?.role === "assistant" &&
        latestMessage.metadata?.mode === "agent"
      ) {
        restoredAgentMessageIds.add(latestMessage.id);
      }
    }

    return deriveChatTimelineRows({
      messages: visibleMessages,
      status,
      lastAssistantMessageIndex,
      expandedAgentMessageIds,
      animateNewToolGroups:
        isCurrentChat &&
        toolGroupMountState.hasCommittedTimeline &&
        !isAutoResuming,
      seenToolGroupIds: isCurrentChat
        ? toolGroupMountState.seenToolGroupIds
        : new Set(),
      seenAgentMessageIds: isCurrentChat
        ? toolGroupMountState.seenAgentMessageIds
        : new Set(),
      restoredAgentMessageIds,
    });
  }, [
    chatId,
    expandedAgentMessageIds,
    isAutoResuming,
    lastAssistantMessageIndex,
    status,
    toolGroupMountState,
    visibleMessages,
  ]);
  const stableTimelineRowsRef = useRef<StableChatTimelineRowsState | null>(
    null,
  );
  const stableTimelineRowsState = useMemo(
    () =>
      stabilizeChatTimelineRows(
        rawTimelineRows,
        stableTimelineRowsRef.current ?? createStableChatTimelineRowsState(),
      ),
    [rawTimelineRows],
  );
  useLayoutEffect(() => {
    stableTimelineRowsRef.current = stableTimelineRowsState;
    toolGroupMountStore.commit(
      chatId,
      stableTimelineRowsState.result,
      isAutoResuming,
    );
  }, [chatId, isAutoResuming, stableTimelineRowsState, toolGroupMountStore]);
  const timelineRows = stableTimelineRowsState.result;
  const navigatorItems = useMemo(
    () => deriveMessageNavigatorItems(visibleMessages, timelineRows),
    [timelineRows, visibleMessages],
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
  const timelineInstanceRef = useRef<LegendListRef | null>(null);
  const positionedAnchorMessageIdRef = useRef<string | null>(null);
  const anchorPositionFrameRef = useRef<number | null>(null);
  const handleTimelineRef = useCallback((instance: LegendListRef | null) => {
    timelineInstanceRef.current = instance;
    setTimelineInstance(instance);
  }, []);
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

  useEffect(() => {
    if (!anchorMessageId) {
      const scrollElement = timelineInstanceRef.current?.getScrollableNode();
      if (scrollElement) {
        scrollElement.dataset.timelineAnchoredEndSpace = "false";
      }
      positionedAnchorMessageIdRef.current = null;
    }

    return () => {
      if (anchorPositionFrameRef.current !== null) {
        cancelAnimationFrame(anchorPositionFrameRef.current);
        anchorPositionFrameRef.current = null;
      }
    };
  }, [anchorMessageId]);

  const handleAnchorSizeChanged = useCallback((size: number) => {
    const scrollElement = timelineInstanceRef.current?.getScrollableNode();
    if (scrollElement) {
      scrollElement.dataset.timelineAnchoredEndSpace = String(size > 0);
    }
  }, []);

  const handleAnchorReady = useCallback(
    ({
      anchorIndex,
      size,
    }: {
      anchorIndex: number | undefined;
      size: number;
    }) => {
      const scrollElement = timelineInstanceRef.current?.getScrollableNode();
      if (scrollElement) {
        scrollElement.dataset.timelineAnchoredEndSpace = String(size > 0);
      }

      if (
        !anchorMessageId ||
        anchorIndex === undefined ||
        positionedAnchorMessageIdRef.current === anchorMessageId
      ) {
        return;
      }

      positionedAnchorMessageIdRef.current = anchorMessageId;
      anchorPositionFrameRef.current = requestAnimationFrame(() => {
        anchorPositionFrameRef.current = null;
        void timelineInstanceRef.current?.scrollToIndex({
          index: anchorIndex,
          animated: true,
          viewPosition: 0,
          viewOffset: CHAT_TIMELINE_ANCHOR_OFFSET,
        });
      });
    },
    [anchorMessageId],
  );

  const anchoredEndSpace = useMemo(() => {
    const anchorIndex = findMessageTimelineAnchorIndex(
      timelineRows,
      anchorMessageId,
    );
    return anchorIndex === undefined
      ? undefined
      : {
          anchorIndex,
          anchorOffset: CHAT_TIMELINE_ANCHOR_OFFSET,
          onReady: handleAnchorReady,
          onSizeChanged: handleAnchorSizeChanged,
        };
  }, [
    anchorMessageId,
    handleAnchorReady,
    handleAnchorSizeChanged,
    timelineRows,
  ]);

  const handleNavigatorSelect = useCallback(
    (item: (typeof navigatorItems)[number]) => {
      window.dispatchEvent(new Event(STICKY_BOTTOM_ESCAPE_EVENT));
      void timelineInstance?.scrollToIndex({
        index: item.rowIndex,
        animated: false,
        viewOffset: 24,
      });
    },
    [timelineInstance],
  );

  const showingLoadingIndicator =
    summarizationStatus?.status === "started" ||
    uploadStatus?.isUploading ||
    shouldShowLoadingDots;
  const timelineExtraData = useMemo(
    () => ({ editingMessageId, status }),
    [editingMessageId, status],
  );
  const handleToolGroupMount = useCallback(
    (rowId: string) => toolGroupMountStore.markToolGroupMounted(chatId, rowId),
    [chatId, toolGroupMountStore],
  );

  const renderTimelineRow = useCallback(
    ({ item: row }: { item: ChatTimelineRow }) => {
      const rowClassName =
        row.kind === "agent-work-header"
          ? "pb-2"
          : row.kind === "agent-activity" || row.kind === "agent-tool-group"
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
      } else if (
        row.kind === "agent-activity" ||
        row.kind === "agent-tool-group"
      ) {
        const effectiveStatus: ChatStatus =
          status === "streaming" &&
          row.messageIndex !== lastAssistantMessageIndex
            ? "ready"
            : status;
        const sharedFileDetails =
          row.message.fileDetails ||
          tempChatFileDetails?.get(row.message.id) ||
          undefined;

        content =
          row.kind === "agent-activity" ? (
            <AgentActivityRow
              deferReasoningCollapseUntilParent={
                row.deferReasoningCollapseUntilParent
              }
              isLastMessage={row.isLastMessage}
              keepLatestReasoningOpenDuringStreaming={
                row.keepLatestReasoningOpenDuringStreaming
              }
              suppressReasoningAutoOpen={row.suppressReasoningAutoOpen}
              message={row.message}
              part={row.part}
              partIndex={row.partIndex}
              sharedFileDetails={sharedFileDetails}
              status={effectiveStatus}
              terminalChunksByToolCallId={row.terminalChunksByToolCallId}
            />
          ) : (
            <AgentToolGroupRow
              activities={row.activities}
              animateOnMount={row.animateOnMount}
              groupId={row.id}
              isLastMessage={row.isLastMessage}
              message={row.message}
              onMount={handleToolGroupMount}
              sharedFileDetails={sharedFileDetails}
              status={effectiveStatus}
              summary={row.summary}
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
          data-message-id={row.kind === "message" ? row.message.id : undefined}
          data-message-role={
            row.kind === "message" ? row.message.role : undefined
          }
          data-timeline-row-kind={row.kind}
          data-timeline-message-id={
            row.kind === "message" ? row.message.id : undefined
          }
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
      handleToolGroupMount,
      isMobile,
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
      <div
        className="mx-auto flex min-h-20 w-full max-w-full flex-col items-start sm:max-w-[768px] sm:min-w-[390px]"
        data-testid="messages-timeline-footer"
      >
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
      <div className="min-h-20" data-testid="messages-timeline-footer" />
    );

  return (
    <FileUrlCacheProvider
      getCachedUrl={getCachedUrl}
      setCachedUrl={setCachedUrl}
    >
      <div className="relative flex-1 min-h-0">
        <LegendList<ChatTimelineRow>
          ref={handleTimelineRef}
          data={timelineRows}
          dataKey={chatId}
          extraData={timelineExtraData}
          keyExtractor={getTimelineRowKey}
          getItemType={getChatTimelineRowType}
          renderItem={renderTimelineRow}
          estimatedItemSize={48}
          recycleItems={false}
          initialScrollAtEnd
          {...(anchoredEndSpace ? { anchoredEndSpace } : {})}
          contentInsetEndAdjustment={contentInsetEndAdjustment}
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

        {!isMobile ? (
          <MessageNavigator
            items={navigatorItems}
            scrollElement={timelineElements.scroll}
            onSelect={handleNavigatorSelect}
          />
        ) : null}

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
