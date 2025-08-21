import { Copy, Check, RotateCcw } from "lucide-react";
import { useState } from "react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import type { ChatStatus } from "@/types";

interface MessageActionsProps {
  messageParts: Array<{ type: string; text?: string }>;
  isUser: boolean;
  isLastAssistantMessage: boolean;
  canRegenerate: boolean;
  onRegenerate: () => void;
  isHovered: boolean;
  status: ChatStatus;
}

export const MessageActions = ({
  messageParts,
  isUser,
  isLastAssistantMessage,
  canRegenerate,
  onRegenerate,
  isHovered,
  status,
}: MessageActionsProps) => {
  const [copied, setCopied] = useState(false);

  const getMessageText = () => {
    return messageParts
      .filter((part: { type: string; text?: string }) => part.type === "text")
      .map((part: { type: string; text?: string }) => part.text || "")
      .join("");
  };

  const handleCopy = async () => {
    const messageText = getMessageText();
    try {
      await navigator.clipboard.writeText(messageText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error("Failed to copy message:", error);
    }
  };

  // Don't show actions for last assistant message when it's loading/streaming
  const isLastAssistantLoading =
    isLastAssistantMessage &&
    (status === "submitted" || status === "streaming");
  const shouldShowActions =
    !isLastAssistantLoading && (isLastAssistantMessage || isHovered);

  return (
    <div
      className={`mt-1 flex items-center space-x-2 transition-opacity duration-200 ease-in-out ${isUser ? "justify-end" : "justify-start"} ${shouldShowActions ? "opacity-100" : "opacity-0"}`}
    >
      {shouldShowActions ? (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleCopy}
                className="p-1.5 opacity-70 hover:opacity-100 transition-opacity rounded hover:bg-secondary text-muted-foreground"
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
                  className="p-1.5 opacity-70 hover:opacity-100 disabled:opacity-50 transition-opacity rounded hover:bg-secondary text-muted-foreground"
                  aria-label="Regenerate response"
                >
                  <RotateCcw size={16} />
                </button>
              </TooltipTrigger>
              <TooltipContent>Regenerate response</TooltipContent>
            </Tooltip>
          )}
        </>
      ) : (
        <>
          {/* Invisible spacer buttons to maintain layout */}
          <div className="p-1.5 w-7 h-7" />
          {!isUser && isLastAssistantMessage && (
            <div className="p-1.5 w-7 h-7" />
          )}
        </>
      )}
    </div>
  );
};
