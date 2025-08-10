"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useState } from "react";
import { ModeToggle } from "@/components/mode-toggle";
import { MessageList } from "./components/MessageList";
import { ChatInput } from "./components/ChatInput";

export default function Page() {
  const {
    messages,
    setMessages,
    sendMessage,
    status,
    stop,
    error,
    regenerate,
  } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/chat",
    }),
  });
  const [input, setInput] = useState("");

  const handleDelete = (id: string) => {
    setMessages(messages.filter((message) => message.id !== id));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim()) {
      sendMessage({ text: input });
      setInput("");
    }
  };

  const handleStop = () => {
    stop();
  };

  const handleRegenerate = () => {
    regenerate();
  };

  return (
    <div className="h-screen bg-background">
      {/* Full width chat interface */}
      <div className="w-full bg-card flex flex-col relative h-full">
        {/* Mode toggle */}
        <div className="absolute top-4 right-4 z-50">
          <ModeToggle />
        </div>
        {/* Chat header */}
        <div className="border-b border-border p-4 bg-card">
          <h2 className="text-lg font-semibold text-card-foreground">HackerAI</h2>
        </div>

        {/* Messages container */}
        <MessageList
          messages={messages}
          onDelete={handleDelete}
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
        />
      </div>
    </div>
  );
}
