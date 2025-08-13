import { UIMessage } from "@ai-sdk/react";
import { Message } from "./Message";
import { RefObject } from "react";

interface MessageListProps {
  messages: UIMessage[];
  onRegenerate: () => void;
  status: "ready" | "submitted" | "streaming" | "error";
  error: Error | null;
  scrollRef: RefObject<HTMLElement | null>;
  contentRef: RefObject<HTMLElement | null>;
}

export const MessageList = ({
  messages,
  onRegenerate,
  status,
  error,
  scrollRef,
  contentRef,
}: MessageListProps) => {
  // Find the last assistant message
  const lastAssistantMessageIndex = messages
    .map((msg, index) => ({ msg, index }))
    .reverse()
    .find(({ msg }) => msg.role === "assistant")?.index;

  return (
    <div
      ref={scrollRef as RefObject<HTMLDivElement>}
      className="flex-1 overflow-y-auto p-4"
    >
      <div
        ref={contentRef as RefObject<HTMLDivElement>}
        className="mx-auto w-full max-w-full sm:max-w-[768px] sm:min-w-[390px] flex flex-col space-y-4 pb-20"
      >
        {messages.length === 0 ? (
          <div className="text-center text-muted-foreground py-8">
            <p>No messages yet. Start a conversation!</p>
          </div>
        ) : (
          messages.map((message, index) => (
            <Message
              key={message.id}
              message={message}
              onRegenerate={onRegenerate}
              canRegenerate={status === "ready" || status === "error"}
              isLastAssistantMessage={
                message.role === "assistant" &&
                index === lastAssistantMessageIndex
              }
              status={status}
            />
          ))
        )}

        {/* Error state */}
        {error && (
          <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-3">
            <p className="text-destructive text-sm mb-2">An error occurred.</p>
            <button
              type="button"
              onClick={onRegenerate}
              className="text-xs bg-destructive text-destructive-foreground px-2 py-1 rounded hover:bg-destructive/90"
            >
              Retry
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
