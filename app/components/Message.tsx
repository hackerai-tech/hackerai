import { UIMessage } from "@ai-sdk/react";
import { Copy, Check, RotateCcw } from "lucide-react";
import { useState } from "react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";

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
  isLastAssistantMessage,
}: MessageProps) => {
  const isUser = message.role === "user";
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const messageText = message.parts
      .filter((part: any) => part.type === "text")
      .map((part: any) => part.text)
      .join("");

    try {
      await navigator.clipboard.writeText(messageText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error("Failed to copy message:", error);
    }
  };

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
            title="Delete message"
          >
            ×
          </button>
        </div>

        {/* Action buttons below message */}
        <div className="mt-2 flex items-center justify-start space-x-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleCopy}
                className="p-1.5 opacity-70 hover:opacity-100 transition-opacity rounded hover:bg-black/5"
                aria-label={copied ? "Copied!" : "Copy message"}
              >
                {copied ? <Check size={16} /> : <Copy size={16} />}
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {copied ? "Copied!" : "Copy message"}
            </TooltipContent>
          </Tooltip>

          {/* Show regenerate only for the last assistant message */}
          {!isUser && isLastAssistantMessage && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onRegenerate}
                  disabled={!canRegenerate}
                  className="p-1.5 opacity-70 hover:opacity-100 disabled:opacity-50 transition-opacity rounded hover:bg-black/5"
                  aria-label="Regenerate response"
                >
                  <RotateCcw size={16} />
                </button>
              </TooltipTrigger>
              <TooltipContent>Regenerate response</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
};
