"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { RefObject, useRef, useEffect, useState, useCallback } from "react";
import { useQuery, usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Messages } from "./Messages";
import { ChatInput } from "./ChatInput";
import { ScrollToBottomButton } from "./ScrollToBottomButton";
import { ComputerSidebar } from "./ComputerSidebar";
import ChatHeader from "./ChatHeader";
import MainSidebar from "./Sidebar";
import Footer from "./Footer";
import { SidebarProvider } from "@/components/ui/sidebar";
import { useMessageScroll } from "../hooks/useMessageScroll";
import { useChatHandlers } from "../hooks/useChatHandlers";
import { useGlobalState } from "../contexts/GlobalState";
import { normalizeMessages } from "@/lib/utils/message-processor";
import { ChatSDKError } from "@/lib/errors";
import { fetchWithErrorHandlers, convertToUIMessages } from "@/lib/utils";
import { toast } from "sonner";
import type { Todo, ChatMessage } from "@/types";
import { v4 as uuidv4 } from "uuid";
import { useIsMobile } from "@/hooks/use-mobile";

export const Chat = ({ id }: { id?: string }) => {
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
    isSwitchingChats,
    setIsSwitchingChats,
    hasActiveChat,
    shouldFetchMessages,
    initializeChat,
    initializeNewChat,
  } = useGlobalState();

  // Use ID from route if available, otherwise global currentChatId, or generate new one
  const [chatId, setChatId] = useState(id || currentChatId || uuidv4());
  // Track if we've already initialized for new chat to prevent infinite loops
  const hasInitializedNewChat = useRef(false);
  // Track if we've initialized for this specific route ID
  const hasInitializedRouteId = useRef<string | null>(null);

  // Handle initial mount and chat initialization
  useEffect(() => {
    if (id && hasInitializedRouteId.current !== id) {
      // Direct URL with ID - initialize immediately
      setChatId(id);
      initializeChat(id, true);
      hasInitializedRouteId.current = id;
      hasInitializedNewChat.current = false;
    } else if (!id && !currentChatId && !hasInitializedNewChat.current) {
      // No ID and no current chat - create new chat
      const newChatId = uuidv4();
      setChatId(newChatId);
      initializeNewChat();
      hasInitializedNewChat.current = true;
      hasInitializedRouteId.current = null;
    } else if (!id && currentChatId && currentChatId !== chatId) {
      // Global state has a different chat - switch to it
      setChatId(currentChatId);
      initializeChat(currentChatId, false);
      hasInitializedRouteId.current = null;
    }
  }, [id, currentChatId, chatId, initializeChat, initializeNewChat]);

  // Use paginated query to load messages in batches of 28
  const paginatedMessages = usePaginatedQuery(
    api.messages.getMessagesByChatId,
    shouldFetchMessages ? { chatId } : "skip",
    { initialNumItems: 28 },
  );

  // Get chat data to retrieve title when loading existing chat
  const chatData = useQuery(
    api.chats.getChatById,
    id || currentChatId ? { id: chatId } : "skip",
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
        const { messages: normalizedMessages, hasChanges } =
          normalizeMessages(messages);
        if (hasChanges) {
          setMessages(normalizedMessages);
        }
        return {
          body: {
            chatId: id,
            messages: normalizedMessages,
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
    onError: (error) => {
      if (error instanceof ChatSDKError && error.type !== "rate_limit") {
        toast.error(error.message);
      }
    },
  });

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
    if (!paginatedMessages.results || paginatedMessages.results.length === 0)
      return;

    // Messages come from server in descending order, reverse for chronological display
    const uiMessages = convertToUIMessages(
      [...paginatedMessages.results].reverse(),
    );

    // Merge strategy: Only sync from Convex if:
    // 1. We have no local messages (initial load)
    // 2. Convex has more messages than local (new messages from server)
    // 3. Message IDs differ (switching chats or real-time updates)
    const shouldSync =
      messages.length === 0 ||
      uiMessages.length > messages.length ||
      (uiMessages.length > 0 &&
        messages.length > 0 &&
        uiMessages[0]?.id !== messages[0]?.id);

    if (shouldSync) {
      setMessages(uiMessages);
    }
  }, [paginatedMessages.results, setMessages, messages]);

  const { scrollRef, contentRef, scrollToBottom, isAtBottom } =
    useMessageScroll();
  const resetSidebarAutoOpenRef = useRef<(() => void) | null>(null);

  // Handle instant scroll to bottom when switching chats
  useEffect(() => {
    if (isSwitchingChats && messages.length > 0) {
      scrollToBottom({ instant: true, force: true });
      setIsSwitchingChats(false);
    }
  }, [messages, scrollToBottom, isSwitchingChats, setIsSwitchingChats]);

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
  const showChatLayout = hasMessages || hasActiveChat;

  return (
    <div className="h-screen bg-background flex flex-col overflow-hidden">
      <div className="flex w-full h-full overflow-hidden">
        {/* Chat Sidebar - Desktop screens only (takes space) */}
        {!isMobile && (
          <div
            className={`transition-all duration-300 ${
              chatSidebarOpen ? "w-72 flex-shrink-0" : "w-0 overflow-hidden"
            }`}
          >
            {chatSidebarOpen && (
              <SidebarProvider
                open={true}
                onOpenChange={() => {}}
                defaultOpen={true}
              >
                <MainSidebar />
              </SidebarProvider>
            )}
          </div>
        )}

        {/* Main Content Area */}
        <div className="flex flex-1 min-w-0">
          {/* Left side - Chat content */}
          <div className="flex flex-col flex-1 min-w-0">
            {/* Unified Header */}
            <ChatHeader
              hasMessages={hasMessages}
              hasActiveChat={hasActiveChat}
              chatTitle={chatTitle}
              id={id}
              chatData={chatData}
              chatSidebarOpen={chatSidebarOpen}
            />

            {/* Chat interface */}
            <div className="bg-background flex flex-col flex-1 relative min-h-0">
              {/* Messages area */}
              {showChatLayout ? (
                <Messages
                  scrollRef={scrollRef as RefObject<HTMLDivElement | null>}
                  contentRef={contentRef as RefObject<HTMLDivElement | null>}
                  messages={messages}
                  onRegenerate={handleRegenerate}
                  onEditMessage={handleEditMessage}
                  status={status}
                  error={error || null}
                  resetSidebarAutoOpen={resetSidebarAutoOpenRef}
                  paginationStatus={paginatedMessages.status}
                  loadMore={paginatedMessages.loadMore}
                  isSwitchingChats={isSwitchingChats}
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
              {(hasMessages || hasActiveChat) && (
                <ChatInput
                  onSubmit={handleSubmit}
                  onStop={handleStop}
                  status={status}
                />
              )}

              <ScrollToBottomButton
                onClick={handleScrollToBottom}
                hasMessages={hasMessages}
                isAtBottom={isAtBottom}
              />
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
  );
};
