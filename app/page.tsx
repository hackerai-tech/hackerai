"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { RefObject } from "react";

import { Messages } from "./components/Messages";
import { ChatInput } from "./components/ChatInput";
import { ScrollToBottomButton } from "./components/ScrollToBottomButton";
import { useMessageScroll } from "./hooks/useMessageScroll";
import { useGlobalState } from "./contexts/GlobalState";

export default function Page() {
  const { input, mode, chatTitle, setChatTitle, clearInput } = useGlobalState();

  const { messages, sendMessage, status, stop, error, regenerate } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/chat",
      body: () => ({
        mode,
      }),
    }),
    onData: ({ data, type }) => {
      if (type === "data-title") {
        setChatTitle((data as { chatTitle: string }).chatTitle);
      }
    },
  });
  const { scrollRef, contentRef, scrollToBottom, isAtBottom } =
    useMessageScroll();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim()) {
      // Clear title when starting a new conversation
      if (messages.length === 0) {
        setChatTitle(null);
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
    <div className="h-screen bg-background">
      {/* Full width chat interface */}
      <div className="w-full bg-background flex flex-col relative h-full">
        {/* Chat header - only show when there are messages */}
        {hasMessages && (
          <div className="border-b border-border px-4 bg-background">
            <div className="mx-auto w-full max-w-full sm:max-w-[768px] sm:min-w-[390px] flex flex-row items-center justify-between pt-3 pb-1 gap-1 sticky top-0 z-10 bg-[var(--background-gray-main)] flex-shrink-0">
              <h2 className="text-lg font-semibold text-foreground">
                {chatTitle || "HackerAI"}
              </h2>
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
          <div className="flex-1 flex flex-col items-center justify-center px-4">
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
        )}

        {/* Scroll to bottom button - positioned outside the main layout */}
        <ScrollToBottomButton
          isVisible={!isAtBottom && messages.length > 0}
          onClick={handleScrollToBottom}
        />
      </div>
    </div>
  );
}
