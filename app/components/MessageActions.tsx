import {
  Copy,
  Check,
  RotateCcw,
  Pencil,
  ThumbsUp,
  ThumbsDown,
} from "lucide-react";
import { useState } from "react";
import type { ChatStatus } from "@/types";
import { WithTooltip } from "@/components/ui/with-tooltip";

interface MessageActionsProps {
  messageText: string;
  isUser: boolean;
  isLastAssistantMessage: boolean;
  canRegenerate: boolean;
  onRegenerate: () => void;
  onEdit: () => void;
  isHovered: boolean;
  isEditing: boolean;
  status: ChatStatus;
  onFeedback?: (type: "positive" | "negative") => void;
  existingFeedback?: "positive" | "negative" | null;
  isAwaitingFeedbackDetails?: boolean;
}

export const MessageActions = ({
  messageText,
  isUser,
  isLastAssistantMessage,
  canRegenerate,
  onRegenerate,
  onEdit,
  isHovered,
  isEditing,
  status,
  onFeedback,
  existingFeedback,
  isAwaitingFeedbackDetails = false,
}: MessageActionsProps) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(messageText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error("Failed to copy message:", error);
    }
  };

  const handleFeedback = (type: "positive" | "negative") => {
    if (onFeedback) {
      onFeedback(type);
    }
  };

  // Don't show actions for last assistant message when it's loading/streaming
  const isLastAssistantLoading =
    isLastAssistantMessage &&
    (status === "submitted" || status === "streaming");
  const shouldShowActions =
    !isLastAssistantLoading && !isEditing && (isUser ? isHovered : true); // Always show for assistant, only on hover for user

  return (
    <div
      className={`mt-1 flex items-center space-x-2 transition-opacity duration-200 ease-in-out ${isUser ? "justify-end" : "justify-start"} ${shouldShowActions ? "opacity-100" : "opacity-0"}`}
    >
      {shouldShowActions ? (
        <>
          <WithTooltip
            display={copied ? "Copied!" : "Copy message"}
            trigger={
              <button
                onClick={handleCopy}
                className="p-1.5 opacity-70 hover:opacity-100 transition-opacity rounded hover:bg-secondary text-muted-foreground"
                aria-label={copied ? "Copied!" : "Copy message"}
              >
                {copied ? <Check size={16} /> : <Copy size={16} />}
              </button>
            }
            side="bottom"
            delayDuration={300}
          />

          {/* Show edit only for user messages */}
          {isUser && (
            <WithTooltip
              display={"Edit message"}
              trigger={
                <button
                  onClick={onEdit}
                  className="p-1.5 opacity-70 hover:opacity-100 transition-opacity rounded hover:bg-secondary text-muted-foreground"
                  aria-label="Edit message"
                >
                  <Pencil size={16} />
                </button>
              }
              side="bottom"
              delayDuration={300}
            />
          )}

          {/* Show feedback buttons only for assistant messages */}
          {!isUser && onFeedback && (
            <>
              {/* Hide positive feedback button when awaiting negative feedback details */}
              {!isAwaitingFeedbackDetails && (
                <WithTooltip
                  display={"Good response"}
                  trigger={
                    <button
                      type="button"
                      onClick={() => handleFeedback("positive")}
                      className={`p-1.5 transition-opacity rounded hover:bg-secondary ${
                        existingFeedback === "positive"
                          ? "opacity-100 text-primary-foreground"
                          : "opacity-70 hover:opacity-100 text-muted-foreground"
                      }`}
                      aria-label="Good response"
                    >
                      <ThumbsUp
                        size={16}
                        fill={
                          existingFeedback === "positive"
                            ? "currentColor"
                            : "none"
                        }
                      />
                    </button>
                  }
                  side="bottom"
                  delayDuration={300}
                />
              )}
              <WithTooltip
                display={"Poor response"}
                trigger={
                  <button
                    type="button"
                    onClick={() => handleFeedback("negative")}
                    className={`p-1.5 transition-opacity rounded hover:bg-secondary ${
                      existingFeedback === "negative" ||
                      isAwaitingFeedbackDetails
                        ? "opacity-100 text-primary-foreground"
                        : "opacity-70 hover:opacity-100 text-muted-foreground"
                    }`}
                    aria-label="Poor response"
                  >
                    <ThumbsDown
                      size={16}
                      fill={
                        existingFeedback === "negative" ||
                        isAwaitingFeedbackDetails
                          ? "currentColor"
                          : "none"
                      }
                    />
                  </button>
                }
                side="bottom"
                delayDuration={300}
              />
            </>
          )}

          {/* Show regenerate only for the last assistant message */}
          {!isUser && isLastAssistantMessage && (
            <WithTooltip
              display={"Regenerate response"}
              trigger={
                <button
                  type="button"
                  onClick={onRegenerate}
                  disabled={!canRegenerate}
                  className="p-1.5 opacity-70 hover:opacity-100 disabled:opacity-50 transition-opacity rounded hover:bg-secondary text-muted-foreground"
                  aria-label="Regenerate response"
                >
                  <RotateCcw size={16} />
                </button>
              }
              side="bottom"
              delayDuration={300}
            />
          )}
        </>
      ) : (
        <>
          {/* Invisible spacer buttons to maintain layout */}
          <div className="p-1.5 w-7 h-7" />
        </>
      )}
    </div>
  );
};
