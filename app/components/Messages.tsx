import { UIMessage } from "@ai-sdk/react";
import { useState, RefObject, useEffect } from "react";
import { MessageActions } from "./MessageActions";
import { MessagePartHandler } from "./MessagePartHandler";
import DotsSpinner from "@/components/ui/dots-spinner";
import { Button } from "@/components/ui/button";
import { MemoizedMarkdown } from "./MemoizedMarkdown";
import { useSidebarAutoOpen } from "../hooks/useSidebarAutoOpen";
import { ChatSDKError } from "@/lib/errors";
import type { ChatStatus } from "@/types";

interface MessagesProps {
  messages: UIMessage[];
  onRegenerate: () => void;
  status: ChatStatus;
  error: Error | null;
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  resetSidebarAutoOpen?: RefObject<(() => void) | null>;
}

export const Messages = ({
  messages,
  onRegenerate,
  status,
  error,
  scrollRef,
  contentRef,
  resetSidebarAutoOpen,
}: MessagesProps) => {
  // Find the last assistant message
  const lastAssistantMessageIndex = messages
    .map((msg, index) => ({ msg, index }))
    .reverse()
    .find(({ msg }) => msg.role === "assistant")?.index;

  // Track hover state for all messages
  const [hoveredMessageId, setHoveredMessageId] = useState<string | null>(null);

  // Handle sidebar auto-opening
  const { resetSidebarFlag } = useSidebarAutoOpen(
    messages,
    lastAssistantMessageIndex,
    status,
  );

  // Expose reset function to parent if provided
  useEffect(() => {
    if (resetSidebarAutoOpen) {
      resetSidebarAutoOpen.current = resetSidebarFlag;
    }
  }, [resetSidebarFlag, resetSidebarAutoOpen]);

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto p-4">
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
            const isLastAssistantMessage =
              message.role === "assistant" &&
              index === lastAssistantMessageIndex;
            const canRegenerate = status === "ready" || status === "error";

            // Check if we should show loader for this message
            const hasTextContent = message.parts?.some(
              (part: { type: string; text?: string }) =>
                (part.type === "text" &&
                  part.text &&
                  part.text.trim() !== "") ||
                part.type === "step-start" ||
                part.type?.startsWith("tool-"),
            );

            const shouldShowLoader =
              isLastAssistantMessage &&
              status === "streaming" &&
              !hasTextContent;

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
                  <div className="prose space-y-3 max-w-none dark:prose-invert min-w-0 overflow-hidden ">
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
            <div className="text-destructive text-sm mb-2">
              {error instanceof ChatSDKError && error.type === "rate_limit" ? (
                <MemoizedMarkdown
                  content={
                    typeof error.cause === "string"
                      ? error.cause
                      : error.message
                  }
                  id={`error-${error.type}`}
                />
              ) : (
                <p>An error occurred.</p>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="destructive" size="sm" onClick={onRegenerate}>
                {error instanceof ChatSDKError && error.type === "rate_limit"
                  ? "Try Again"
                  : "Retry"}
              </Button>
              {error instanceof ChatSDKError && error.type === "rate_limit" && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    window.open(
                      "https://github.com/hackerai-tech/hackerai",
                      "_blank",
                    )
                  }
                >
                  Self Host
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
