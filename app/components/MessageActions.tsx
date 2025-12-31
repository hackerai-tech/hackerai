import {
  Copy,
  Check,
  RotateCcw,
  Pencil,
  ThumbsUp,
  ThumbsDown,
  Split,
} from "lucide-react";
import { useState } from "react";
import Image from "next/image";
import type { ChatStatus } from "@/types";
import { WithTooltip } from "@/components/ui/with-tooltip";
import { Button } from "@/components/ui/button";
import { SourcesDialog } from "./SourcesDialog";

interface MessageActionsProps {
  messageText: string;
  isUser: boolean;
  isLastAssistantMessage: boolean;
  canRegenerate: boolean;
  onRegenerate: () => void;
  onEdit: () => void;
  onBranch?: () => void;
  isHovered: boolean;
  isEditing: boolean;
  status: ChatStatus;
  onFeedback?: (type: "positive" | "negative") => void;
  existingFeedback?: "positive" | "negative" | null;
  isAwaitingFeedbackDetails?: boolean;
  hasFileContent?: boolean;
  isTemporaryChat?: boolean;
  sources?: Array<{
    title?: string;
    url: string;
    text?: string;
    publishedDate?: string;
  }>;
}

export const MessageActions = ({
  messageText,
  isUser,
  isLastAssistantMessage,
  canRegenerate,
  onRegenerate,
  onEdit,
  onBranch,
  isHovered,
  isEditing,
  status,
  onFeedback,
  existingFeedback,
  isAwaitingFeedbackDetails = false,
  hasFileContent = false,
  isTemporaryChat = false,
  sources = [],
}: MessageActionsProps) => {
  const [copied, setCopied] = useState(false);
  const [isSourcesOpen, setIsSourcesOpen] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);

  const getFaviconUrl = (domain: string) => {
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
  };

  const getDomain = (url: string) => {
    try {
      const u = new URL(url);
      return `${u.protocol}//${u.hostname}`;
    } catch {
      return url;
    }
  };

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

  const handleRegenerate = () => {
    if (isRegenerating) return;
    setIsRegenerating(true);
    onRegenerate();
  };

  // Don't show actions for last assistant message when it's loading/streaming
  const isLastAssistantLoading =
    isLastAssistantMessage &&
    (status === "submitted" || status === "streaming");
  const shouldShowActions =
    !isLastAssistantLoading && !isEditing && (isUser ? isHovered : true); // Always show for assistant, only on hover for user

  // Reset isRegenerating when status changes back to idle
  const isLoading = status === "submitted" || status === "streaming";
  if (!isLoading && isRegenerating) {
    setIsRegenerating(false);
  }

  return (
    <div
      className={`mt-1 flex flex-wrap items-center gap-2 transition-opacity duration-200 ease-in-out ${isUser ? "justify-end" : "justify-start"} ${shouldShowActions ? "opacity-100" : "opacity-0"}`}
    >
      {shouldShowActions ? (
        <>
          <div className="flex items-center space-x-2">
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

            {/* Show feedback buttons only for assistant messages and not in temporary chats */}
            {!isUser && onFeedback && !isTemporaryChat && (
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
                    onClick={handleRegenerate}
                    disabled={!canRegenerate || isRegenerating}
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

            {/* Show branch only for assistant messages and not in temporary chats */}
            {!isUser && onBranch && !isTemporaryChat && (
              <WithTooltip
                display={"Branch in new chat"}
                trigger={
                  <button
                    type="button"
                    onClick={onBranch}
                    className="p-1.5 opacity-70 hover:opacity-100 transition-opacity rounded hover:bg-secondary text-muted-foreground"
                    aria-label="Branch in new chat"
                  >
                    <Split size={16} />
                  </button>
                }
                side="bottom"
                delayDuration={300}
              />
            )}
          </div>

          {/* Sources (only for assistant messages with web results) - positioned at the end */}
          {!isUser && sources.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsSourcesOpen(true)}
              className="group/footnote bg-background hover:bg-muted flex w-fit items-center gap-1.5 rounded-3xl px-3 py-1.5 h-auto"
              aria-label="View sources"
            >
              <div className="flex flex-row-reverse">
                {sources.slice(0, 3).map((src, idx) => {
                  const domain = getDomain(src.url);
                  return (
                    <div
                      key={`src-${idx}`}
                      className="border-background bg-background flex items-center overflow-clip rounded-full -ms-1.5 first:me-0 border-2 group-hover/footnote:border-muted relative"
                    >
                      <div className="relative inline-block shrink-0">
                        <Image
                          alt=""
                          width={20}
                          height={20}
                          className="w-5 h-5 rounded-full shadow-[inset_0_0_0_1px_rgba(0,0,0,0.05)] duration-200 motion-safe:transition-opacity opacity-100"
                          src={getFaviconUrl(domain)}
                          unoptimized
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="text-muted-foreground mt-[-1px] text-[13px] font-medium">
                Sources
              </div>
            </Button>
          )}
        </>
      ) : (
        <>
          {/* Invisible spacer buttons to maintain layout */}
          <div className="p-1.5 w-7 h-7" />
        </>
      )}

      {/* Sources Dialog */}
      {!isUser && sources.length > 0 && (
        <SourcesDialog
          open={isSourcesOpen}
          onOpenChange={setIsSourcesOpen}
          sources={sources}
        />
      )}
    </div>
  );
};
