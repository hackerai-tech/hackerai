import { UIMessage } from "@ai-sdk/react";
import { Copy, Check, RotateCcw } from "lucide-react";
import { useState } from "react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { MemoizedMarkdown } from "./MemoizedMarkdown";

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
    <div className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}>
      <div
        className={`w-full max-w-full overflow-hidden ${
          isUser
            ? "bg-secondary rounded-lg px-4 py-3 text-primary-foreground border border-border"
            : "text-foreground"
        }`}
      >
        <div className="prose space-y-3 prose-sm max-w-none dark:prose-invert min-w-0 overflow-hidden">
          {message.parts.map((part) => {
            if (part.type === "text") {
              return (
                <MemoizedMarkdown
                  key={`${message.id}-text`}
                  id={message.id}
                  content={part.text}
                />
              );
            }
          })}
        </div>
      </div>

      {/* Action buttons outside message bubble */}
      <div
        className={`mt-1 flex items-center space-x-2 ${isUser ? "justify-end" : "justify-start"}`}
      >
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
          <TooltipContent>{copied ? "Copied!" : "Copy message"}</TooltipContent>
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
      </div>
    </div>
  );
};
