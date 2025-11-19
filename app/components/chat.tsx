"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { RefObject, useRef, useEffect, useState } from "react";
import { useQuery, usePaginatedQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { FileDetails } from "@/types/file";
import { Messages } from "./Messages";
import { ChatInput } from "./ChatInput";
import { ComputerSidebar } from "./ComputerSidebar";
import ChatHeader from "./ChatHeader";
import MainSidebar from "./Sidebar";
import Footer from "./Footer";
import { SidebarProvider } from "@/components/ui/sidebar";
import { useMessageScroll } from "../hooks/useMessageScroll";
import { useChatHandlers } from "../hooks/useChatHandlers";
import { useGlobalState } from "../contexts/GlobalState";
import { useFileUpload } from "../hooks/useFileUpload";
import { useDocumentDragAndDrop } from "../hooks/useDocumentDragAndDrop";
import { DragDropOverlay } from "./DragDropOverlay";
import { normalizeMessages } from "@/lib/utils/message-processor";
import { ChatSDKError } from "@/lib/errors";
import { fetchWithErrorHandlers, convertToUIMessages } from "@/lib/utils";
import { toast } from "sonner";
import type { Todo, ChatMessage, ChatMode, SubscriptionTier } from "@/types";
import { shouldTreatAsMerge } from "@/lib/utils/todo-utils";
import { v4 as uuidv4 } from "uuid";
import { useIsMobile } from "@/hooks/use-mobile";
import { ConvexErrorBoundary } from "./ConvexErrorBoundary";
import { useAutoResume } from "../hooks/useAutoResume";
import { useLatestRef } from "../hooks/useLatestRef";
import { useDataStream } from "./DataStreamProvider";
import { removeDraft } from "@/lib/utils/client-storage";

export const Chat = ({
  chatId: routeChatId,
  autoResume,
}: {
  chatId?: string;
  autoResume: boolean;
}) => {
  const isMobile = useIsMobile();
  const { setDataStream, isAutoResuming, setIsAutoResuming } = useDataStream();
  const [uploadStatus, setUploadStatus] = useState<{
    message: string;
    isUploading: boolean;
  } | null>(null);
  const [rateLimitWarning, setRateLimitWarning] = useState<{
    remaining: number;
    resetTime: Date;
    mode: ChatMode;
    subscription: SubscriptionTier;
  } | null>(null);

  const {
    chatTitle,
    setChatTitle,
    chatMode,
    setChatMode,
    sidebarOpen,
    chatSidebarOpen,
    setChatSidebarOpen,
    mergeTodos,
    setTodos,
    replaceAssistantTodos,
    currentChatId,
    temporaryChatsEnabled,
    setChatReset,
    hasUserDismissedRateLimitWarning,
    setHasUserDismissedRateLimitWarning,
    messageQueue,
    dequeueNext,
    clearQueue,
    queueBehavior,
    todos,
  } = useGlobalState();

  // Simple logic: use route chatId if provided, otherwise generate new one
  const [chatId, setChatId] = useState<string>(() => {
    return routeChatId || uuidv4();
  });

  // Track whether this is an existing chat (prop-driven initially, flips after first completion)
  const [isExistingChat, setIsExistingChat] = useState<boolean>(!!routeChatId);
  const shouldFetchMessages = isExistingChat;

  // Refs to avoid stale closures in callbacks
  const isExistingChatRef = useLatestRef(isExistingChat);
  const chatModeRef = useLatestRef(chatMode);

  // Suppress transient "Chat Not Found" while server creates the chat
  const [awaitingServerChat, setAwaitingServerChat] = useState<boolean>(false);

  // Store file metadata separately from AI SDK message state (for temporary chats)
  const [tempChatFileDetails, setTempChatFileDetails] = useState<
    Map<string, FileDetails[]>
  >(new Map());

  const temporaryChatsEnabledRef = useLatestRef(temporaryChatsEnabled);
  // Use global state ref so streaming callback reads latest value
  const hasUserDismissedWarningRef = useLatestRef(
    hasUserDismissedRateLimitWarning,
  );
  // Use ref for todos to avoid stale closures in auto-send
  const todosRef = useLatestRef(todos);

  // Ensure we only initialize mode from server once per chat id
  const hasInitializedModeFromChatRef = useRef(false);

  // Unified reset: respond to route and global new-chat trigger
  useEffect(() => {
    // If global state indicates a new chat, prefer that over any stale route id
    if (currentChatId === null) {
      if (routeChatId) {
        return;
      }
      setChatId(uuidv4());
      setIsExistingChat(false);
      setChatTitle(null);
      // Messages will be cleared below after useChat is ready
      return;
    }

    // If a chat id is present in the route, treat as existing chat
    if (routeChatId) {
      setChatId(routeChatId);
      setIsExistingChat(true);
      return;
    }
  }, [routeChatId, currentChatId, setChatTitle]);

  // Use paginated query to load messages in batches of 28
  const paginatedMessages = usePaginatedQuery(
    api.messages.getMessagesByChatId,
    shouldFetchMessages ? { chatId } : "skip",
    { initialNumItems: 28 },
  );

  // Get chat data to retrieve title when loading existing chat
  const chatData = useQuery(
    api.chats.getChatByIdFromClient,
    shouldFetchMessages ? { id: chatId } : "skip",
  );

  // Convert paginated Convex messages to UI format for useChat
  // Messages come from server in descending order (newest first from pagination)
  // We need to reverse them to show chronological order (oldest first)
  const initialMessages: ChatMessage[] =
    paginatedMessages.results && paginatedMessages.results.length > 0
      ? convertToUIMessages([...paginatedMessages.results].reverse())
      : [];

  // State to prevent double-processing of queue
  const [isProcessingQueue, setIsProcessingQueue] = useState(false);
  // Ref to track when "Send Now" is actively processing to prevent auto-processing interference
  const isSendingNowRef = useRef(false);
  // Ref to track if user manually stopped - prevents auto-processing until new message submitted
  const hasManuallyStoppedRef = useRef(false);

  const {
    messages,
    sendMessage,
    setMessages,
    status,
    stop,
    error,
    regenerate,
    resumeStream,
  } = useChat({
    id: chatId,
    messages: initialMessages,
    experimental_throttle: 100,
    generateId: () => uuidv4(),

    transport: new DefaultChatTransport({
      api: "/api/chat",
      fetch: async (input, init) => {
        // Dynamically route to correct API based on current mode
        const url =
          input === "/api/chat" && chatModeRef.current === "agent"
            ? "/api/agent"
            : input;
        return fetchWithErrorHandlers(url, init);
      },
      prepareSendMessagesRequest: ({ id, messages, body }) => {
        const {
          messages: normalizedMessages,
          lastMessage,
          hasChanges,
        } = normalizeMessages(messages as ChatMessage[]);
        if (hasChanges) {
          setMessages(normalizedMessages);
        }

        const isTemporaryChat =
          !isExistingChatRef.current && temporaryChatsEnabledRef.current;

        // Strip URLs from file parts before sending to backend
        // This ensures backend always generates fresh URLs (prevents 403 errors from expired URLs)
        // Backend will fetch URLs using fileId, supporting both S3 and Convex storage
        const stripUrlsFromMessages = (msgs: ChatMessage[]): ChatMessage[] => {
          return msgs.map((msg) => {
            if (!msg.parts || msg.parts.length === 0) return msg;
            const strippedParts = msg.parts.map((part: any) => {
              if (part.type === "file" && "url" in part) {
                // Remove URL property, keeping all other file metadata
                const { url, ...partWithoutUrl } = part;
                return partWithoutUrl;
              }
              return part;
            });
            return {
              ...msg,
              parts: strippedParts,
            };
          });
        };

        const messagesToSend = isTemporaryChat
          ? normalizedMessages
          : lastMessage;
        const messagesWithoutUrls = stripUrlsFromMessages(messagesToSend);

        return {
          body: {
            chatId: id,
            messages: messagesWithoutUrls,
            ...body,
          },
        };
      },
    }),

    onData: (dataPart) => {
      setDataStream((ds) => (ds ? [...ds, dataPart] : []));
      if (dataPart.type === "data-title")
        setChatTitle((dataPart.data as { chatTitle: string }).chatTitle);
      if (dataPart.type === "data-upload-status") {
        const uploadData = dataPart.data as {
          message: string;
          isUploading: boolean;
        };
        setUploadStatus(uploadData.isUploading ? uploadData : null);
      }
      if (dataPart.type === "data-rate-limit-warning") {
        const warningData = dataPart.data as {
          remaining: number;
          resetTime: string;
          mode: ChatMode;
          subscription: SubscriptionTier;
        };

        // Only show or update warning if user hasn't dismissed it
        if (!hasUserDismissedWarningRef.current) {
          setRateLimitWarning({
            remaining: warningData.remaining,
            resetTime: new Date(warningData.resetTime),
            mode: warningData.mode,
            subscription: warningData.subscription,
          });
        }
      }
      if (dataPart.type === "data-file-metadata") {
        const fileData = dataPart.data as {
          messageId: string;
          fileDetails: FileDetails[];
        };

        // Store in parallel state (outside AI SDK control)
        setTempChatFileDetails((prev) => {
          const next = new Map(prev);
          next.set(fileData.messageId, fileData.fileDetails);
          return next;
        });
      }
    },
    onToolCall: ({ toolCall }) => {
      if (toolCall.toolName === "todo_write" && toolCall.input) {
        const todoInput = toolCall.input as { merge?: boolean; todos: Todo[] };
        if (!todoInput.todos) return;
        // Determine last assistant message id to stamp/replace
        const lastAssistant = [...messages]
          .reverse()
          .find((m) => m.role === "assistant");
        const lastAssistantId = lastAssistant?.id;

        const treatAsMerge = shouldTreatAsMerge(
          todoInput.merge,
          todoInput.todos,
        );

        if (!treatAsMerge) {
          // Fresh plan creation: replace assistant todos with new ones, stamp with current assistant id if present.
          replaceAssistantTodos(todoInput.todos, lastAssistantId);
        } else {
          // Partial update: merge
          mergeTodos(todoInput.todos);
        }
      }
    },
    onFinish: () => {
      setIsAutoResuming(false);
      setAwaitingServerChat(false);
      setUploadStatus(null);
      // For new chats, flip the state so it becomes an existing chat
      const isTemporaryChat =
        !isExistingChatRef.current && temporaryChatsEnabledRef.current;
      if (!isExistingChatRef.current && !isTemporaryChat) {
        setIsExistingChat(true);
        // Clear the "new" draft when transitioning from new chat to existing chat
        removeDraft("new");
      }
    },
    onError: (error) => {
      setIsAutoResuming(false);
      setAwaitingServerChat(false);
      setUploadStatus(null);
      if (error instanceof ChatSDKError && error.type !== "rate_limit") {
        toast.error(error.message);
      }
    },
  });

  // Auto-resume controlled by prop; default to true when a specific chat id is present, false on "/"
  useAutoResume({
    autoResume,
    initialMessages,
    resumeStream,
    setMessages,
  });

  // Register a reset function with global state so initializeNewChat can call it
  useEffect(() => {
    const reset = () => {
      setMessages([]);
      setIsExistingChat(false);
      setChatId(uuidv4());
      setChatTitle(null);
      setTodos([]);
      setAwaitingServerChat(false);
      setUploadStatus(null);
    };
    setChatReset(reset);
    return () => setChatReset(null);
  }, [setChatReset, setMessages, setChatTitle, setTodos]);

  // Set chat title and load todos when chat data is loaded
  useEffect(() => {
    // Only process when we intend to fetch for an existing chat
    if (!shouldFetchMessages) {
      return;
    }

    const dataId = (chatData as any)?.id as string | undefined;
    // Ignore when no data or data is stale (doesn't match current chatId)
    if (!chatData || dataId !== chatId) {
      return;
    }

    if (chatData.title) {
      // Always update title from server data to ensure consistency
      setChatTitle(chatData.title);
    }

    // Load todos from the chat data if they exist.
    if (chatData.todos) {
      // setTodos signature expects Todo[], so derive the new array first
      const nextTodos: Todo[] = (() => {
        const incoming: Todo[] = chatData.todos as Todo[];
        if (!incoming || incoming.length === 0) return [] as Todo[];

        // Split by assistant attribution
        const incomingAssistant: Todo[] = incoming.filter((t: Todo) =>
          Boolean(t.sourceMessageId),
        );
        const incomingManual: Todo[] = incoming.filter(
          (t: Todo) => !t.sourceMessageId,
        );

        const prevManual: Todo[] = [];
        // We can't access previous value directly here without functional setter.
        // Fallback: since server is source of truth, treat incoming manual todos as updates only for ids we already have.
        // The actual merge of manual todos will be handled elsewhere when tool updates come in.

        // Build manual map from previous
        // Replace assistant todos entirely with incoming assistant todos and keep incoming manual ones as-is
        return [...incomingAssistant, ...incomingManual] as Todo[];
      })();

      setTodos(nextTodos);
    }
    // Server has responded for this chat id; stop suppressing not-found state
    setAwaitingServerChat(false);
    // Initialize mode from server once per chat id (only for existing chats)
    if (!hasInitializedModeFromChatRef.current && isExistingChat) {
      const slug = (chatData as any).default_model_slug;
      if (slug === "ask" || slug === "agent") {
        setChatMode(slug);
        hasInitializedModeFromChatRef.current = true;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    chatData,
    setChatTitle,
    setTodos,
    shouldFetchMessages,
    isExistingChat,
    chatId,
  ]);

  // Reset the one-time initializer when chat changes
  useEffect(() => {
    hasInitializedModeFromChatRef.current = false;
  }, [chatId]);

  // Sync Convex real-time data with useChat messages
  useEffect(() => {
    if (!paginatedMessages.results || paginatedMessages.results.length === 0) {
      return;
    }

    // Messages come from server in descending order, reverse for chronological display
    const uiMessages = convertToUIMessages(
      [...paginatedMessages.results].reverse(),
    );

    // Simple sync: always use server messages for existing chats
    if (isExistingChat) {
      setMessages(uiMessages);
    }
  }, [paginatedMessages.results, setMessages, isExistingChat, chatId]);

  const { scrollRef, contentRef, scrollToBottom, isAtBottom } =
    useMessageScroll();
  const resetSidebarAutoOpenRef = useRef<(() => void) | null>(null);

  // File upload with drag and drop support
  const {
    isDragOver,
    showDragOverlay,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
  } = useFileUpload(chatMode);

  // Handle instant scroll to bottom when loading existing chat messages
  useEffect(() => {
    if (isExistingChat && messages.length > 0) {
      scrollToBottom({ instant: true, force: true });
    }
  }, [messages.length, scrollToBottom, isExistingChat]);

  // Automatic queue processing - send next queued message when ready
  useEffect(() => {
    if (
      status === "ready" &&
      messageQueue.length > 0 &&
      !isProcessingQueue &&
      !isSendingNowRef.current && // Don't auto-process if "Send Now" is active
      !hasManuallyStoppedRef.current && // Don't auto-process if user manually stopped
      chatMode === "agent" &&
      queueBehavior === "queue" // Only auto-process in queue mode
    ) {
      setIsProcessingQueue(true);
      const nextMessage = dequeueNext();

      if (nextMessage) {
        // Send the message with files if available
        sendMessage(
          {
            text: nextMessage.text,
            files: nextMessage.files
              ? nextMessage.files.map((f) => ({
                  type: "file" as const,
                  filename: f.file.name,
                  mediaType: f.file.type,
                  url: f.url,
                  fileId: f.fileId,
                }))
              : undefined,
          },
          {
            body: {
              mode: chatMode,
              todos: todosRef.current,
              temporary: temporaryChatsEnabledRef.current,
            },
          },
        );
      }

      // Reset processing flag after brief delay
      setTimeout(() => setIsProcessingQueue(false), 100);
    }
  }, [
    status,
    messageQueue.length,
    isProcessingQueue,
    chatMode,
    dequeueNext,
    sendMessage,
    temporaryChatsEnabledRef,
    queueBehavior,
  ]);

  // Keep a ref to the latest messageQueue to avoid stale closures
  const messageQueueRef = useRef(messageQueue);
  useEffect(() => {
    messageQueueRef.current = messageQueue;
  }, [messageQueue]);

  // Clear queue when switching from Agent to Ask mode
  useEffect(() => {
    if (chatMode === "ask" && messageQueueRef.current.length > 0) {
      clearQueue();
    }
  }, [chatMode, clearQueue]);

  // Clear queue when navigating to a different chat
  useEffect(() => {
    return () => {
      if (messageQueueRef.current.length > 0) {
        clearQueue();
      }
    };
  }, [chatId, clearQueue]);

  // Document-level drag and drop listeners encapsulated in a hook
  useDocumentDragAndDrop({
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
  });

  // Chat handlers
  const {
    handleSubmit,
    handleStop,
    handleRegenerate,
    handleRetry,
    handleEditMessage,
    handleSendNow,
  } = useChatHandlers({
    chatId,
    messages,
    resetSidebarAutoOpenRef,
    sendMessage,
    stop,
    regenerate,
    setMessages,
    isExistingChat,
    activateChatLocally: () => {
      setIsExistingChat(true);
      setAwaitingServerChat(true);
    },
    status,
    isSendingNowRef,
    hasManuallyStoppedRef,
  });

  const handleScrollToBottom = () => scrollToBottom({ force: true });

  // Rate limit warning dismiss handler
  const handleDismissRateLimitWarning = () => {
    setRateLimitWarning(null);
    setHasUserDismissedRateLimitWarning(true);
  };

  // Branch chat handler
  const branchChatMutation = useMutation(api.messages.branchChat);

  const handleBranchMessage = async (messageId: string) => {
    try {
      const newChatId = await branchChatMutation({ messageId });
      // Navigate to the new chat
      window.location.href = `/c/${newChatId}`;
    } catch (error) {
      console.error("Failed to branch chat:", error);
      throw error;
    }
  };

  const hasMessages = messages.length > 0;
  const showChatLayout = hasMessages || isExistingChat;

  // UI-level temporary chat flag
  const isTempChat = !isExistingChat && temporaryChatsEnabled;

  // Get branched chat info directly from chatData (no additional query needed)
  const branchedFromChatId = chatData?.branched_from_chat_id;
  const branchedFromChatTitle = (chatData as any)?.branched_from_title;

  // Check if we tried to load an existing chat but it doesn't exist or doesn't belong to user
  const isChatNotFound =
    isExistingChat &&
    chatData === null &&
    shouldFetchMessages &&
    !awaitingServerChat;

  return (
    <ConvexErrorBoundary>
      <div className="h-full bg-background flex flex-col overflow-hidden">
        <div className="flex w-full h-full overflow-hidden">
          {/* Chat Sidebar - Desktop screens: always mounted, collapses to icon rail when closed */}
          {!isMobile && (
            <div
              data-testid="sidebar"
              className={`transition-all duration-300 ${
                chatSidebarOpen ? "w-72 flex-shrink-0" : "w-12 flex-shrink-0"
              }`}
            >
              <SidebarProvider
                open={chatSidebarOpen}
                onOpenChange={setChatSidebarOpen}
                defaultOpen={true}
              >
                <MainSidebar />
              </SidebarProvider>
            </div>
          )}

          {/* Main Content Area */}
          <div className="flex flex-1 min-w-0 relative">
            {/* Left side - Chat content */}
            <div className="flex flex-col flex-1 min-w-0">
              {/* Unified Header */}
              <ChatHeader
                hasMessages={hasMessages}
                hasActiveChat={isExistingChat}
                chatTitle={chatTitle}
                id={routeChatId}
                chatData={chatData}
                chatSidebarOpen={chatSidebarOpen}
                isExistingChat={isExistingChat}
                isChatNotFound={isChatNotFound}
                branchedFromChatTitle={branchedFromChatTitle}
              />

              {/* Chat interface */}
              <div className="bg-background flex flex-col flex-1 relative min-h-0">
                {/* Messages area */}
                {isChatNotFound ? (
                  <div className="flex-1 flex flex-col items-center justify-center px-4 py-8 min-h-0">
                    <div className="w-full max-w-full sm:max-w-[768px] sm:min-w-[390px] flex flex-col items-center space-y-8">
                      <div className="text-center">
                        <h1 className="text-2xl font-bold text-foreground mb-2">
                          Chat Not Found
                        </h1>
                        <p className="text-muted-foreground">
                          This chat doesn&apos;t exist or you don&apos;t have
                          permission to view it.
                        </p>
                      </div>
                    </div>
                  </div>
                ) : showChatLayout ? (
                  <Messages
                    scrollRef={scrollRef as RefObject<HTMLDivElement | null>}
                    contentRef={contentRef as RefObject<HTMLDivElement | null>}
                    messages={messages}
                    setMessages={setMessages}
                    onRegenerate={handleRegenerate}
                    onRetry={handleRetry}
                    onEditMessage={handleEditMessage}
                    onBranchMessage={handleBranchMessage}
                    status={status}
                    error={error || null}
                    resetSidebarAutoOpen={resetSidebarAutoOpenRef}
                    paginationStatus={paginatedMessages.status}
                    loadMore={paginatedMessages.loadMore}
                    isSwitchingChats={false}
                    isTemporaryChat={isTempChat}
                    tempChatFileDetails={tempChatFileDetails}
                    finishReason={chatData?.finish_reason}
                    uploadStatus={uploadStatus}
                    mode={chatMode ?? (chatData as any)?.default_model_slug}
                    chatTitle={chatTitle}
                    branchedFromChatId={branchedFromChatId}
                    branchedFromChatTitle={branchedFromChatTitle}
                  />
                ) : (
                  <div className="flex-1 flex flex-col min-h-0">
                    <div className="flex-1 flex flex-col items-center justify-center px-4 py-8 min-h-0">
                      <div className="w-full max-w-full sm:max-w-[768px] sm:min-w-[390px] flex flex-col items-center space-y-8">
                        <div className="text-center">
                          {temporaryChatsEnabled ? (
                            <>
                              <h1 className="text-3xl font-bold text-foreground mb-2">
                                Temporary Chat
                              </h1>
                              <p className="text-muted-foreground max-w-md mx-auto px-4 py-3">
                                This chat won&apos;t appear in history, use or
                                update HackerAI&apos;s memory, or be used to
                                train models. This chat will be deleted when you
                                refresh the page.
                              </p>
                            </>
                          ) : (
                            <>
                              <h1 className="text-3xl font-bold text-foreground mb-2">
                                HackerAI
                              </h1>
                              <p className="text-muted-foreground">
                                Your AI pentest assistant
                              </p>
                            </>
                          )}
                        </div>

                        {/* Centered input (desktop only) */}
                        {!isMobile && (
                          <div className="w-full">
                            <ChatInput
                              onSubmit={handleSubmit}
                              onStop={handleStop}
                              onSendNow={handleSendNow}
                              status={status}
                              hideStop={isAutoResuming}
                              isCentered={true}
                              hasMessages={hasMessages}
                              isAtBottom={isAtBottom}
                              onScrollToBottom={handleScrollToBottom}
                              isNewChat={!isExistingChat}
                              chatId={chatId}
                              rateLimitWarning={
                                rateLimitWarning ? rateLimitWarning : undefined
                              }
                              onDismissRateLimitWarning={
                                handleDismissRateLimitWarning
                              }
                            />
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Footer - only show when user is not logged in */}
                    <div className="flex-shrink-0">
                      <Footer />
                    </div>
                  </div>
                )}

                {/* Chat Input - Bottom placement (also for mobile new chats) */}
                {(hasMessages || isExistingChat || isMobile) &&
                  !isChatNotFound && (
                    <ChatInput
                      onSubmit={handleSubmit}
                      onStop={handleStop}
                      onSendNow={handleSendNow}
                      status={status}
                      hideStop={isAutoResuming}
                      hasMessages={hasMessages}
                      isAtBottom={isAtBottom}
                      onScrollToBottom={handleScrollToBottom}
                      isNewChat={!isExistingChat}
                      chatId={chatId}
                      rateLimitWarning={
                        rateLimitWarning ? rateLimitWarning : undefined
                      }
                      onDismissRateLimitWarning={handleDismissRateLimitWarning}
                    />
                  )}
              </div>
            </div>

            {/* Desktop Computer Sidebar */}
            {!isMobile && (
              <div
                className={`transition-all duration-300 min-w-0 ${
                  sidebarOpen ? "w-1/2 flex-shrink-0" : "w-0 overflow-hidden"
                }`}
              >
                {sidebarOpen && <ComputerSidebar />}
              </div>
            )}

            {/* Drag and Drop Overlay - covers main content area only (excludes sidebars) */}
            <DragDropOverlay
              isVisible={showDragOverlay}
              isDragOver={isDragOver}
            />
          </div>
        </div>

        {/* Mobile Computer Sidebar */}
        {isMobile && sidebarOpen && (
          <div className="flex fixed inset-0 z-50 bg-background items-center justify-center p-4">
            <div className="w-full max-w-4xl h-full">
              <ComputerSidebar />
            </div>
          </div>
        )}

        {/* Overlay Chat Sidebar - Mobile screens */}
        {isMobile && chatSidebarOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/50 flex"
            onClick={() => setChatSidebarOpen(false)}
          >
            <div
              className="w-full max-w-80 h-full bg-background shadow-lg transform transition-transform duration-300 ease-in-out"
              onClick={(e) => e.stopPropagation()}
            >
              <MainSidebar isMobileOverlay={true} />
            </div>
            {/* Clickable area to close sidebar */}
            <div className="flex-1" />
          </div>
        )}
      </div>
    </ConvexErrorBoundary>
  );
};
