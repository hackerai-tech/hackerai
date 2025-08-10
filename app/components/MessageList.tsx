import { UIMessage } from "@ai-sdk/react";
import { Message } from "./Message";
import { Spinner } from "../ui";

interface MessageListProps {
  messages: UIMessage[];
  onDelete: (id: string) => void;
  onRegenerate: () => void;
  status: "ready" | "submitted" | "streaming" | "error";
  error: Error | null;
}

export const MessageList = ({
  messages,
  onDelete,
  onRegenerate,
  status,
  error,
}: MessageListProps) => {
  // Find the last assistant message
  const lastAssistantMessageIndex = messages
    .map((msg, index) => ({ msg, index }))
    .reverse()
    .find(({ msg }) => msg.role === "assistant")?.index;

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {messages.length === 0 ? (
        <div className="text-center text-muted-foreground py-8">
          <p>No messages yet. Start a conversation!</p>
        </div>
      ) : (
        messages.map((message, index) => (
          <Message
            key={message.id}
            message={message}
            onDelete={onDelete}
            onRegenerate={onRegenerate}
            canRegenerate={status === "ready" || status === "error"}
            isLastAssistantMessage={
              message.role === "assistant" && index === lastAssistantMessageIndex
            }
          />
        ))
      )}

      {/* Loading state */}
      {(status === "submitted" || status === "streaming") && (
        <div className="flex justify-start">
          <div className="bg-muted text-muted-foreground rounded-lg px-3 py-2 flex items-center space-x-2">
            {status === "submitted" && <Spinner size="sm" variant="primary" />}
            <span className="text-sm">
              {status === "submitted" ? "Thinking..." : "Typing..."}
            </span>
          </div>
        </div>
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
  );
};