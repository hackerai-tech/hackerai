import { UIMessage } from "@ai-sdk/react";
import { useState, RefObject } from "react";
import { MessageActions } from "./MessageActions";
import { MessagePartHandler } from "./MessagePartHandler";
import DotsSpinner from "@/components/ui/dots-spinner";

interface MessagesProps {
  messages: UIMessage[];
  onRegenerate: () => void;
  status: "ready" | "submitted" | "streaming" | "error";
  error: Error | null;
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
}

export const Messages = ({
  messages,
  onRegenerate,
  status,
  error,
  scrollRef,
  contentRef,
}: MessagesProps) => {
  // Find the last assistant message
  const lastAssistantMessageIndex = messages
    .map((msg, index) => ({ msg, index }))
    .reverse()
    .find(({ msg }) => msg.role === "assistant")?.index;

  // Track hover state for all messages
  const [hoveredMessageId, setHoveredMessageId] = useState<string | null>(null);

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto p-4"
    >
      <div
        ref={contentRef}
        className="mx-auto w-full max-w-full sm:max-w-[768px] sm:min-w-[390px] flex flex-col space-y-4 pb-20"
      >
        {messages.length === 0 ? (
          <div className="text-center text-muted-foreground py-8">
            <p>No messages yet. Start a conversation!</p>
          </div>
        ) : (
          messages.map((message, index) => {
            const isUser = message.role === "user";
            const isHovered = hoveredMessageId === message.id;
            const isLastAssistantMessage = message.role === "assistant" && index === lastAssistantMessageIndex;
            const canRegenerate = status === "ready" || status === "error";

            // Check if we should show loader for this message
            const hasTextContent = message.parts?.some(
              (part: { type: string; text?: string }) =>
                part.type === "text" && part.text && part.text.trim() !== "",
            );

            const shouldShowLoader = isLastAssistantMessage && status === "streaming" && !hasTextContent;

            return (
              <div
                key={message.id}
                className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}
                onMouseEnter={() => setHoveredMessageId(message.id)}
                onMouseLeave={() => setHoveredMessageId(null)}
              >
                <div
                  className={`${
                    isUser
                      ? "max-w-[80%] bg-secondary rounded-lg px-4 py-3 text-primary-foreground border border-border"
                      : "w-full text-foreground"
                  } overflow-hidden`}
                >
                  <div className="prose space-y-3 prose-sm max-w-none dark:prose-invert min-w-0 overflow-hidden">
                    {message.parts.map((part, partIndex) => (
                      <MessagePartHandler
                        key={`${message.id}-${partIndex}`}
                        message={message}
                        part={part}
                        partIndex={partIndex}
                        status={status}
                      />
                    ))}
                  </div>
                </div>

                {/* Loading state */}
                {shouldShowLoader && (
                  <div className="mt-1 flex justify-start">
                    <div className="bg-muted text-muted-foreground rounded-lg px-3 py-2 flex items-center space-x-2">
                      <DotsSpinner size="sm" variant="primary" />
                    </div>
                  </div>
                )}

                <MessageActions
                  messageParts={message.parts}
                  isUser={isUser}
                  isLastAssistantMessage={isLastAssistantMessage}
                  canRegenerate={canRegenerate}
                  onRegenerate={onRegenerate}
                  isHovered={isHovered}
                  status={status}
                />
              </div>
            );
          })
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
