"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { RefObject, useRef } from "react";
import { Messages } from "./components/Messages";
import { ChatInput } from "./components/ChatInput";
import { ScrollToBottomButton } from "./components/ScrollToBottomButton";
import { ComputerSidebar } from "./components/ComputerSidebar";
import Header from "./components/Header";
import { useMessageScroll } from "./hooks/useMessageScroll";
import { useGlobalState } from "./contexts/GlobalState";
import { normalizeMessages } from "@/lib/utils/message-processor";
import { ChatSDKError } from "@/lib/errors";
import { fetchWithErrorHandlers } from "@/lib/utils";
import { toast } from "sonner";
import { useAppAuth } from "./hooks/useAppAuth";
import { isWorkOSEnabled } from "@/lib/auth/client";

export default function Page() {
  const { input, mode, chatTitle, setChatTitle, clearInput, sidebarOpen } =
    useGlobalState();

  const { user, loading } = useAppAuth();

  const { messages, sendMessage, status, stop, error, regenerate } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/chat",
      fetch: fetchWithErrorHandlers,
      prepareSendMessagesRequest: ({ messages, body }) => {
        // Normalize messages on the frontend before sending to API
        const normalizedMessages = normalizeMessages(messages);

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
      if (isWorkOSEnabled() && !user) {
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
    <div className="h-screen bg-background overflow-hidden">
      {/* Show header when there are no messages */}
      {!hasMessages && <Header />}

      <div
        className={`flex max-w-full ${!hasMessages ? "h-[calc(100vh-58px)]" : "h-full"}`}
      >
        {/* Chat interface - responsive width based on screen size and sidebar state */}
        <div
          className={`bg-background flex flex-col relative transition-all duration-300 min-w-0 ${
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
            <div className="flex-1 flex flex-col px-4">
              {/* Centered content area */}
              <div className="flex-1 flex flex-col items-center justify-center">
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
              {!loading && !user && (
                <div className="text-muted-foreground relative flex min-h-8 w-full items-center justify-center p-2 text-center text-xs md:px-[60px]">
                  <span className="text-sm leading-none">
                    By messaging HackerAI, you agree to our{" "}
                    <a
                      href="/terms-of-service"
                      target="_blank"
                      className="text-foreground underline decoration-foreground"
                      rel="noreferrer"
                    >
                      Terms
                    </a>{" "}
                    and have read our{" "}
                    <a
                      href="/privacy-policy"
                      target="_blank"
                      className="text-foreground underline decoration-foreground"
                      rel="noreferrer"
                    >
                      Privacy Policy
                    </a>
                    .
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Scroll to bottom button - positioned relative to chat area */}
          <div
            className={`fixed bottom-34 z-40 transition-all duration-300 ${
              sidebarOpen
                ? "left-1/2 desktop:left-1/4 -translate-x-1/2" // Center of full screen on mobile/tablet, center of left half on desktop
                : "left-1/2 -translate-x-1/2" // Center of full screen when sidebar is closed
            }`}
          >
            <ScrollToBottomButton
              isVisible={!isAtBottom && messages.length > 0}
              onClick={handleScrollToBottom}
            />
          </div>
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
