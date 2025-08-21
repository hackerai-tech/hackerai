"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { RefObject, useRef } from "react";
import { Messages } from "./components/Messages";
import { ChatInput } from "./components/ChatInput";
import { ScrollToBottomButton } from "./components/ScrollToBottomButton";
import { ComputerSidebar } from "./components/ComputerSidebar";
import Header from "./components/Header";
import Footer from "./components/Footer";
import { useMessageScroll } from "./hooks/useMessageScroll";
import { useGlobalState } from "./contexts/GlobalState";
import { normalizeMessages } from "@/lib/utils/message-processor";
import { ChatSDKError } from "@/lib/errors";
import { fetchWithErrorHandlers } from "@/lib/utils";
import { toast } from "sonner";
import { useAppAuth } from "./hooks/useAppAuth";
import { isWorkOSEnabled } from "@/lib/auth/client";

export default function Page() {
  const {
    input,
    mode,
    chatTitle,
    setChatTitle,
    clearInput,
    sidebarOpen,
    isTodoPanelExpanded,
  } = useGlobalState();

  const { user, loading } = useAppAuth();

  const {
    messages,
    sendMessage,
    setMessages,
    status,
    stop,
    error,
    regenerate,
  } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/chat",
      fetch: fetchWithErrorHandlers,
      prepareSendMessagesRequest: ({ messages, body }) => {
        // Normalize messages on the frontend before sending to API
        const { messages: normalizedMessages, hasChanges } =
          normalizeMessages(messages);

        // Only update messages if normalization made changes
        if (hasChanges) {
          setMessages(normalizedMessages);
        }

        return {
          body: {
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
    onError: (error) => {
      if (error instanceof ChatSDKError) {
        // For rate limit errors, let them flow to the Messages component
        // For other errors, show toast
        if (error.type !== "rate_limit") {
          toast.error(error.message);
        }
      }
    },
  });
  const { scrollRef, contentRef, scrollToBottom, isAtBottom } =
    useMessageScroll();

  // Ref to reset sidebar auto-open flag
  const resetSidebarAutoOpenRef = useRef<(() => void) | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim()) {
      // Only require authentication in WorkOS mode
      if (isWorkOSEnabled() && !user && loading === false) {
        window.location.href = "/login";
        return;
      }

      // Clear title when starting a new conversation
      if (messages.length === 0) {
        setChatTitle(null);
      }

      // Reset sidebar auto-open flag for new request
      if (resetSidebarAutoOpenRef.current) {
        resetSidebarAutoOpenRef.current();
      }

      sendMessage(
        { text: input },
        {
          body: {
            mode,
          },
        },
      );
      clearInput();
    }
  };

  const handleStop = () => {
    stop();
  };

  const handleRegenerate = () => {
    regenerate();
  };

  const handleScrollToBottom = () => {
    scrollToBottom();
  };

  const hasMessages = messages.length > 0;

  return (
    <div className="h-screen bg-background flex flex-col overflow-hidden">
      {/* Show header when there are no messages */}
      {!hasMessages && (
        <div className="flex-shrink-0">
          <Header />
        </div>
      )}

      <div className="flex max-w-full flex-1 min-h-0">
        {/* Chat interface - responsive width based on screen size and sidebar state */}
        <div
          className={`bg-background flex flex-col h-full relative transition-all duration-300 min-w-0 ${
            sidebarOpen
              ? "w-full desktop:w-1/2 desktop:flex-shrink-0" // Full width on mobile/tablet, half on desktop when sidebar is open
              : "w-full"
          }`}
        >
          {/* Chat header - only show when there are messages */}
          {hasMessages && (
            <div className="px-4 bg-background">
              <div className="mx-auto w-full max-w-full sm:max-w-[768px] sm:min-w-[390px] flex flex-row items-center justify-between pt-3 pb-1 gap-1 sticky top-0 z-10 bg-background flex-shrink-0">
                <div className="max-w-full sm:max-w-[768px] sm:min-w-[390px] flex w-full flex-col gap-[4px] overflow-hidden">
                  <div className="text-foreground text-lg font-medium w-full flex flex-row items-center justify-between flex-1 min-w-0 gap-2">
                    <div className="flex flex-row items-center gap-[6px] flex-1 min-w-0">
                      <span className="whitespace-nowrap text-ellipsis overflow-hidden">
                        {chatTitle || "HackerAI"}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Conditional layout based on messages */}
          {hasMessages ? (
            <>
              {/* Messages container */}
              <Messages
                scrollRef={scrollRef as RefObject<HTMLDivElement | null>}
                contentRef={contentRef as RefObject<HTMLDivElement | null>}
                messages={messages}
                onRegenerate={handleRegenerate}
                status={status}
                error={error || null}
                resetSidebarAutoOpen={resetSidebarAutoOpenRef}
              />

              {/* Input area */}
              <ChatInput
                onSubmit={handleSubmit}
                onStop={handleStop}
                status={status}
              />
            </>
          ) : (
            /* Centered layout for empty state */
            <div className="flex-1 flex flex-col min-h-0">
              {/* Centered content area */}
              <div className="flex-1 flex flex-col items-center justify-center px-4 py-8 min-h-0">
                <div className="w-full max-w-full sm:max-w-[768px] sm:min-w-[390px] flex flex-col items-center space-y-8">
                  {/* Centered title */}
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

          {/* Scroll to bottom button - positioned relative to chat area */}
          {(() => {
            const shouldShowScrollButton =
              hasMessages && !isAtBottom && !isTodoPanelExpanded;
            if (!shouldShowScrollButton) return null;
            return (
              <div
                className={`fixed bottom-42 z-40 transition-all duration-300 ${
                  sidebarOpen
                    ? "left-1/2 desktop:left-1/4 -translate-x-1/2"
                    : "left-1/2 -translate-x-1/2"
                }`}
              >
                <ScrollToBottomButton
                  isVisible={true}
                  onClick={handleScrollToBottom}
                />
              </div>
            );
          })()}
        </div>

        {/* Computer Sidebar - responsive behavior */}
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

      {/* Mobile/Tablet full-screen sidebar */}
      {sidebarOpen && (
        <div className="desktop:hidden flex fixed inset-0 z-50 bg-background items-center justify-center p-4">
          <div className="w-full max-w-4xl h-full">
            <ComputerSidebar />
          </div>
        </div>
      )}
    </div>
  );
}
