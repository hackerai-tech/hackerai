import { UIMessage } from "@ai-sdk/react";

interface MessageProps {
  message: UIMessage;
  onDelete: (id: string) => void;
  onRegenerate: () => void;
  canRegenerate: boolean;
  isLastAssistantMessage: boolean;
}

export const Message = ({ 
  message, 
  onDelete, 
  onRegenerate, 
  canRegenerate,
  isLastAssistantMessage 
}: MessageProps) => {
  const isUser = message.role === "user";
  
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] rounded-lg px-3 py-2 ${
          isUser
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-muted-foreground"
        }`}
      >
        <div className="flex items-start justify-between">
          <div className="flex-1">
            {message.parts.map((part: any, index: number) =>
              part.type === "text" ? (
                <span key={index}>{part.text}</span>
              ) : null,
            )}
          </div>
          <button
            onClick={() => onDelete(message.id)}
            className="ml-2 text-xs opacity-70 hover:opacity-100 flex-shrink-0"
            aria-label="Delete message"
          >
            ×
          </button>
        </div>
        
        {/* Show regenerate only for the last assistant message */}
        {!isUser && isLastAssistantMessage && (
          <div className="mt-2 pt-2 border-t border-border/20">
            <button
              type="button"
              onClick={onRegenerate}
              disabled={!canRegenerate}
              className="text-xs opacity-70 hover:opacity-100 disabled:opacity-50"
              aria-label="Regenerate response"
            >
              🔄 Regenerate
            </button>
          </div>
        )}
      </div>
    </div>
  );
};