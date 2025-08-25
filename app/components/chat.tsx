"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { RefObject, useRef, useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Messages } from "./Messages";
import { ChatInput } from "./ChatInput";
import { ScrollToBottomButton } from "./ScrollToBottomButton";
import { ComputerSidebar } from "./ComputerSidebar";
import Header from "./Header";
import Footer from "./Footer";
import { useMessageScroll } from "../hooks/useMessageScroll";
import { useGlobalState } from "../contexts/GlobalState";
import { normalizeMessages } from "@/lib/utils/message-processor";
import { ChatSDKError } from "@/lib/errors";
import { fetchWithErrorHandlers, convertToUIMessages } from "@/lib/utils";
import { toast } from "sonner";
import type { Todo, ChatMessage } from "@/types";
import { v4 as uuidv4 } from "uuid";

export const Chat = ({ id }: { id?: string }) => {
  // Generate or use provided chat ID
  const [chatId] = useState(() => id || uuidv4());
  // Track whether we should start fetching messages (after first submit for new chats)
  const [shouldFetchMessages, setShouldFetchMessages] = useState(!!id);
  // Track whether the user has started a chat session this run
  const [hasActiveChat, setHasActiveChat] = useState(!!id);

  const {
    input,
    mode,
    chatTitle,
    setChatTitle,
    clearInput,
    sidebarOpen,
    mergeTodos,
    todos,
  } = useGlobalState();

  // Use "skip" to conditionally disable the query
  const messagesData = useQuery(
    api.messages.getMessagesByChatId,
    shouldFetchMessages ? { chatId } : "skip",
  );

  // Get chat data to retrieve title when loading existing chat
  const chatData = useQuery(
    api.chats.getChatById,
    id ? { id: chatId } : "skip",
  );

  // Mutations for message operations
  const deleteLastAssistantMessage = useMutation(
    api.messages.deleteLastAssistantMessage,
  );
  const saveMessageFromClient = useMutation(api.messages.saveMessageFromClient);

  // Convert Convex messages to UI format for useChat
  const initialMessages: ChatMessage[] =
    messagesData && messagesData !== null
      ? convertToUIMessages(messagesData)
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
    if (chatData && chatData.title && !chatTitle) {
      setChatTitle(chatData.title);
    }

    // Load todos from the chat data if they exist
    if (chatData && chatData.todos && chatData.todos.length > 0) {
      mergeTodos(chatData.todos);
    }
  }, [chatData, chatTitle, setChatTitle, mergeTodos]);

  // Sync Convex real-time data with useChat messages
  useEffect(() => {
    if (!messagesData || messagesData === null) return;

    const uiMessages = convertToUIMessages(messagesData);
    setMessages(uiMessages);
  }, [messagesData, setMessages]);

  const { scrollRef, contentRef, scrollToBottom, isAtBottom } =
    useMessageScroll();
  const resetSidebarAutoOpenRef = useRef<(() => void) | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim()) {
      if (messages.length === 0) {
        setChatTitle(null);
        // Update URL to use the actual chatId (whether provided or generated)
        window.history.replaceState({}, "", `/c/${chatId}`);
        // Enable message fetching after first submit for new chats
        if (!shouldFetchMessages) {
          setShouldFetchMessages(true);
        }
        // Ensure we render the chat layout immediately
        setHasActiveChat(true);
      }

      if (resetSidebarAutoOpenRef.current) {
        resetSidebarAutoOpenRef.current();
      }

      sendMessage(
        { text: input },
        {
          body: {
            mode,
            todos,
          },
        },
      );
      clearInput();
    }
  };

  const handleStop = async () => {
    // Save the current assistant message before stopping
    stop();

    const lastMessage = messages[messages.length - 1];
    if (
      lastMessage &&
      lastMessage.role === "assistant" &&
      status === "streaming"
    ) {
      try {
        await saveMessageFromClient({
          id: lastMessage.id,
          chatId,
          role: lastMessage.role,
          parts: lastMessage.parts,
        });
      } catch (error) {
        console.error("Failed to save message on stop:", error);
      }
    }
  };

  const handleRegenerate = async () => {
    // Remove the last assistant message from the UI and database
    await deleteLastAssistantMessage({ chatId });

    regenerate({
      body: {
        mode,
        todos,
        regenerate: true,
      },
    });
  };

  const handleScrollToBottom = () => scrollToBottom();

  const hasMessages = messages.length > 0;
  const showChatLayout = hasMessages || hasActiveChat;

  return (
    <div className="h-screen bg-background flex flex-col overflow-hidden">
      {/* Header for empty state */}
      {!hasMessages && !hasActiveChat && (
        <div className="flex-shrink-0">
          <Header />
        </div>
      )}

      <div className="flex max-w-full flex-1 min-h-0">
        {/* Chat interface */}
        <div
          className={`bg-background flex flex-col h-full relative transition-all duration-300 min-w-0 ${
            sidebarOpen
              ? "w-full desktop:w-1/2 desktop:flex-shrink-0"
              : "w-full"
          }`}
        >
          {/* Chat header */}
          {(hasMessages || hasActiveChat) && (
            <div className="px-4 bg-background">
              <div className="mx-auto w-full max-w-full sm:max-w-[768px] sm:min-w-[390px] flex flex-row items-center justify-between pt-3 pb-1 gap-1 sticky top-0 z-10 bg-background flex-shrink-0">
                <div className="max-w-full sm:max-w-[768px] sm:min-w-[390px] flex w-full flex-col gap-[4px] overflow-hidden">
                  <div className="text-foreground text-lg font-medium w-full flex flex-row items-center justify-between flex-1 min-w-0 gap-2">
                    <div className="flex flex-row items-center gap-[6px] flex-1 min-w-0">
                      <span className="whitespace-nowrap text-ellipsis overflow-hidden">
                        {chatTitle ||
                          (id && chatData === undefined ? "" : "New Chat")}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Messages area */}
          {showChatLayout ? (
            <Messages
              scrollRef={scrollRef as RefObject<HTMLDivElement | null>}
              contentRef={contentRef as RefObject<HTMLDivElement | null>}
              messages={messages}
              onRegenerate={handleRegenerate}
              status={status}
              error={error || null}
              resetSidebarAutoOpen={resetSidebarAutoOpenRef}
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

        {/* Desktop Sidebar */}
        <div
          className={`hidden desktop:block transition-all duration-300 min-w-0 ${
            sidebarOpen
              ? "desktop:w-1/2 desktop:flex-shrink-0"
              : "desktop:w-0 desktop:overflow-hidden"
          }`}
        >
          {sidebarOpen && <ComputerSidebar />}
        </div>
      </div>

      {/* Mobile Sidebar */}
      {sidebarOpen && (
        <div className="desktop:hidden flex fixed inset-0 z-50 bg-background items-center justify-center p-4">
          <div className="w-full max-w-4xl h-full">
            <ComputerSidebar />
          </div>
        </div>
      )}
    </div>
  );
};
