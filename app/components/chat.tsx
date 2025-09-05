"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { RefObject, useRef, useEffect, useState } from "react";
import { useQuery, usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
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
import { DragDropOverlay } from "./DragDropOverlay";
import { normalizeMessages } from "@/lib/utils/message-processor";
import { ChatSDKError } from "@/lib/errors";
import { fetchWithErrorHandlers, convertToUIMessages } from "@/lib/utils";
import { toast } from "sonner";
import type { Todo, ChatMessage } from "@/types";
import { v4 as uuidv4 } from "uuid";
import { useIsMobile } from "@/hooks/use-mobile";
import { ConvexErrorBoundary } from "./ConvexErrorBoundary";

export const Chat = ({ chatId: routeChatId }: { chatId?: string }) => {
  const isMobile = useIsMobile();

  const {
    chatTitle,
    setChatTitle,
    sidebarOpen,
    chatSidebarOpen,
    setChatSidebarOpen,
    mergeTodos,
    setTodos,
    currentChatId,
  } = useGlobalState();

  // Simple logic: use route chatId if provided, otherwise generate new one
  const [chatId, setChatId] = useState<string>(() => {
    return routeChatId || uuidv4();
  });

  // Track whether this is an existing chat (prop-driven initially, flips after first completion)
  const [isExistingChat, setIsExistingChat] = useState<boolean>(!!routeChatId);
  const shouldFetchMessages = isExistingChat;

  // Unified reset: respond to route and global new-chat trigger
  useEffect(() => {
    // If a chat id is present in the route, treat as existing chat
    if (routeChatId) {
      setChatId(routeChatId);
      setIsExistingChat(true);
      return;
    }

    // If no route id and global state indicates new chat (null), create a fresh id
    if (currentChatId === null) {
      setChatId(uuidv4());
      setIsExistingChat(false);
      setChatTitle(null);
      // Messages will be cleared below after useChat is ready
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
    api.chats.getChatById,
    shouldFetchMessages ? { id: chatId } : "skip",
  );

  // Convert paginated Convex messages to UI format for useChat
  // Messages come from server in descending order (newest first from pagination)
  // We need to reverse them to show chronological order (oldest first)
  const initialMessages: ChatMessage[] =
    paginatedMessages.results && paginatedMessages.results.length > 0
      ? convertToUIMessages([...paginatedMessages.results].reverse())
      : [];

  const {
    messages,
    sendMessage,
    setMessages,
    status,
    stop,
    error,
    regenerate,
  } = useChat({
    id: chatId,
    messages: initialMessages,
    generateId: () => uuidv4(),
    transport: new DefaultChatTransport({
      api: "/api/chat",
      fetch: fetchWithErrorHandlers,
      prepareSendMessagesRequest: ({ id, messages, body }) => {
        const {
          messages: normalizedMessages,
          lastMessage,
          hasChanges,
        } = normalizeMessages(messages as ChatMessage[]);
        if (hasChanges) {
          setMessages(normalizedMessages);
        }

        return {
          body: {
            chatId: id,
            messages: lastMessage,
            ...body,
          },
        };
      },
    }),
    onData: ({ data, type }) => {
      if (type === "data-title") {
        setChatTitle((data as { chatTitle: string }).chatTitle);
      }
    },
    onToolCall: ({ toolCall }) => {
      if (toolCall.toolName === "todo_write" && toolCall.input) {
        const todoInput = toolCall.input as { merge: boolean; todos: Todo[] };
        if (todoInput.todos) {
          mergeTodos(todoInput.todos);
        }
      }
    },
    onFinish: () => {
      // For new chats, navigate to the proper route after first message
      if (!isExistingChat) {
        // Use window.history.replaceState to update URL without triggering navigation
        window.history.replaceState(null, "", `/c/${chatId}`);
        // Flip the state so it becomes an existing chat
        setIsExistingChat(true);
      }
    },
    onError: (error) => {
      if (error instanceof ChatSDKError && error.type !== "rate_limit") {
        toast.error(error.message);
      }
    },
  });

  // Clear messages when starting a new chat (after useChat hook is ready)
  useEffect(() => {
    if (!routeChatId && currentChatId === null) {
      setMessages([]);
    }
  }, [routeChatId, currentChatId, setMessages]);

  // Set chat title and load todos when chat data is loaded
  useEffect(() => {
    if (chatData && chatData.title) {
      // Always update title from server data to ensure consistency
      setChatTitle(chatData.title);
    }

    // Load todos from the chat data if they exist, replacing existing todos
    if (chatData && chatData.todos && chatData.todos.length > 0) {
      setTodos(chatData.todos);
    } else if (chatData && (!chatData.todos || chatData.todos.length === 0)) {
      // If chat has no todos, clear existing todos
      setTodos([]);
    }
  }, [chatData, setChatTitle, setTodos]);

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
  } = useFileUpload();

  // Handle instant scroll to bottom when loading existing chat messages
  useEffect(() => {
    if (isExistingChat && messages.length > 0) {
      scrollToBottom({ instant: true, force: true });
    }
  }, [messages.length, scrollToBottom, isExistingChat]);

  // Set up drag and drop event listeners
  useEffect(() => {
    const handleDocumentDragEnter = (e: DragEvent) => handleDragEnter(e);
    const handleDocumentDragLeave = (e: DragEvent) => handleDragLeave(e);
    const handleDocumentDragOver = (e: DragEvent) => handleDragOver(e);
    const handleDocumentDrop = (e: DragEvent) => handleDrop(e);

    document.addEventListener("dragenter", handleDocumentDragEnter);
    document.addEventListener("dragleave", handleDocumentDragLeave);
    document.addEventListener("dragover", handleDocumentDragOver);
    document.addEventListener("drop", handleDocumentDrop);

    return () => {
      document.removeEventListener("dragenter", handleDocumentDragEnter);
      document.removeEventListener("dragleave", handleDocumentDragLeave);
      document.removeEventListener("dragover", handleDocumentDragOver);
      document.removeEventListener("drop", handleDocumentDrop);
    };
  }, [handleDragEnter, handleDragLeave, handleDragOver, handleDrop]);

  // Chat handlers
  const { handleSubmit, handleStop, handleRegenerate, handleEditMessage } =
    useChatHandlers({
      chatId,
      messages,
      resetSidebarAutoOpenRef,
      sendMessage,
      stop,
      regenerate,
      setMessages,
    });

  const handleScrollToBottom = () => scrollToBottom({ force: true });

  const hasMessages = messages.length > 0;
  const showChatLayout = hasMessages || isExistingChat;

  // Check if we tried to load an existing chat but it doesn't exist or doesn't belong to user
  const isChatNotFound =
    isExistingChat && chatData === null && shouldFetchMessages;

  return (
    <ConvexErrorBoundary>
      <div className="h-full bg-background flex flex-col overflow-hidden">
        <div className="flex w-full h-full overflow-hidden">
          {/* Chat Sidebar - Desktop screens: always mounted, collapses to icon rail when closed */}
          {!isMobile && (
            <div
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
                          This chat doesn't exist or you don't have permission
                          to view it.
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
                    onEditMessage={handleEditMessage}
                    status={status}
                    error={error || null}
                    resetSidebarAutoOpen={resetSidebarAutoOpenRef}
                    paginationStatus={paginatedMessages.status}
                    loadMore={paginatedMessages.loadMore}
                    isSwitchingChats={false}
                  />
                ) : (
                  <div className="flex-1 flex flex-col min-h-0">
                    <div className="flex-1 flex flex-col items-center justify-center px-4 py-8 min-h-0">
                      <div className="w-full max-w-full sm:max-w-[768px] sm:min-w-[390px] flex flex-col items-center space-y-8">
                        <div className="text-center">
                          <h1 className="text-3xl font-bold text-foreground mb-2">
                            HackerAI
                          </h1>
                          <p className="text-muted-foreground">
                            Your AI pentest assistant
                          </p>
                        </div>

                        {/* Centered input */}
                        <div className="w-full">
                          <ChatInput
                            onSubmit={handleSubmit}
                            onStop={handleStop}
                            status={status}
                            isCentered={true}
                            hasMessages={hasMessages}
                            isAtBottom={isAtBottom}
                            onScrollToBottom={handleScrollToBottom}
                          />
                        </div>
                      </div>
                    </div>

                    {/* Footer - only show when user is not logged in */}
                    <div className="flex-shrink-0">
                      <Footer />
                    </div>
                  </div>
                )}

                {/* Chat Input - Always show when authenticated */}
                {(hasMessages || isExistingChat) && !isChatNotFound && (
                  <ChatInput
                    onSubmit={handleSubmit}
                    onStop={handleStop}
                    status={status}
                    hasMessages={hasMessages}
                    isAtBottom={isAtBottom}
                    onScrollToBottom={handleScrollToBottom}
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
