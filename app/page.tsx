"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useState } from "react";

import { MessageList } from "./components/MessageList";
import { ChatInput } from "./components/ChatInput";
import { ScrollToBottomButton } from "./components/ScrollToBottomButton";
import { useMessageScroll } from "./hooks/useMessageScroll";

export type ChatMode = "agent" | "ask";

export default function Page() {
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<ChatMode>("agent");

  const {
    messages,
    sendMessage,
    status,
    stop,
    error,
    regenerate,
  } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/chat",
      body: () => ({
        mode,
      }),
    }),
  });
  const { scrollRef, contentRef, scrollToBottom, isAtBottom } =
    useMessageScroll();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim()) {
      sendMessage(
        { text: input },
        {
          body: {
            mode,
          },
        },
      );
      setInput("");
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

  return (
    <div className="h-screen bg-background">
      {/* Full width chat interface */}
      <div className="w-full bg-background flex flex-col relative h-full">
        {/* Chat header */}
        <div className="border-b border-border px-4 bg-background">
          <div className="mx-auto w-full max-w-full sm:max-w-[768px] sm:min-w-[390px] flex flex-row items-center justify-between pt-3 pb-1 gap-1 sticky top-0 z-10 bg-[var(--background-gray-main)] flex-shrink-0">
            <h2 className="text-lg font-semibold text-foreground">HackerAI</h2>
          </div>
        </div>

        {/* Messages container */}
        <MessageList
          scrollRef={scrollRef}
          contentRef={contentRef}
          messages={messages}
          onRegenerate={handleRegenerate}
          status={status}
          error={error || null}
        />

        {/* Input area */}
        <ChatInput
          input={input}
          setInput={setInput}
          onSubmit={handleSubmit}
          onStop={handleStop}
          status={status}
          mode={mode}
          setMode={setMode}
        />

        {/* Scroll to bottom button - positioned outside the main layout */}
        <ScrollToBottomButton
          isVisible={!isAtBottom && messages.length > 0}
          onClick={handleScrollToBottom}
        />
      </div>
    </div>
  );
}
