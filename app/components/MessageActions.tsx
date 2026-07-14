import {
  Copy,
  Check,
  RotateCcw,
  Pencil,
  ThumbsUp,
  ThumbsDown,
  Split,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import type { ChatStatus } from "@/types";
import { WithTooltip } from "@/components/ui/with-tooltip";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatMessageActionTimestamp } from "@/lib/utils/message-time";
import { SourcesDialog } from "./SourcesDialog";

interface MessageActionsProps {
  messageText: string;
  isUser: boolean;
  isLastAssistantMessage: boolean;
  canRegenerate: boolean;
  onRegenerate: () => void | Promise<void>;
  onEdit: () => void;
  onBranch?: () => void;
  isHovered: boolean;
  isEditing: boolean;
  isMobile?: boolean;
  messageCreatedAt?: number;
  status: ChatStatus;
  onFeedback?: (type: "positive" | "negative") => void;
  existingFeedback?: "positive" | "negative" | null;
  isAwaitingFeedbackDetails?: boolean;
  isTemporaryChat?: boolean;
  sources?: Array<{
    title?: string;
    url: string;
    text?: string;
    publishedDate?: string;
  }>;
}

interface MessageActionVisibility {
  shouldRenderActions: boolean;
  actionsAreVisible: boolean;
  shouldReserveTimestamp: boolean;
  timestampIsVisible: boolean;
}

const timestampClassName =
  "flex h-7 items-center px-1.5 text-sm leading-none text-muted-foreground tabular-nums whitespace-nowrap transition-opacity duration-200 ease-in-out";

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

export function getMessageActionVisibility({
  isUser,
  isLastAssistantMessage,
  isMobile,
  isHovered,
  isEditing,
  isLastAssistantLoading,
  hasTimestamp,
}: {
  isUser: boolean;
  isLastAssistantMessage: boolean;
  isMobile: boolean;
  isHovered: boolean;
  isEditing: boolean;
  isLastAssistantLoading: boolean;
  hasTimestamp: boolean;
}): MessageActionVisibility {
  const shouldRenderActions = !isLastAssistantLoading && !isEditing;
  const isHistoricalAssistant = !isUser && !isLastAssistantMessage;
  const requiresDesktopHover = isUser || isHistoricalAssistant;
  const actionsAreVisible =
    shouldRenderActions && (!requiresDesktopHover || isMobile || isHovered);
  const shouldReserveTimestamp =
    shouldRenderActions && !isMobile && hasTimestamp;
  const timestampIsVisible = shouldReserveTimestamp && isHovered;

  return {
    shouldRenderActions,
    actionsAreVisible,
    shouldReserveTimestamp,
    timestampIsVisible,
  };
}

function MessageTimestamp({
  dateTime,
  display,
  isVisible,
}: {
  dateTime: string;
  display: string;
  isVisible: boolean;
}) {
  return (
    <time
      dateTime={dateTime}
      className={cn(
        timestampClassName,
        isVisible
          ? "opacity-70"
          : "opacity-0 group-focus-within/message-actions:opacity-70",
      )}
    >
      {display}
    </time>
  );
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
  isMobile = false,
  messageCreatedAt,
  status,
  onFeedback,
  existingFeedback,
  isAwaitingFeedbackDetails = false,
  isTemporaryChat = false,
  sources = [],
}: MessageActionsProps) => {
  const [copied, setCopied] = useState(false);
  const [isSourcesOpen, setIsSourcesOpen] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const regenerateInFlightRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

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
    if (!canRegenerate || regenerateInFlightRef.current) return;
    regenerateInFlightRef.current = true;
    setIsRegenerating(true);

    const resetRegenerateGuard = () => {
      regenerateInFlightRef.current = false;
      if (mountedRef.current) {
        setIsRegenerating(false);
      }
    };

    void Promise.resolve()
      .then(onRegenerate)
      .catch((error) => {
        console.error("Failed to regenerate response:", error);
      })
      .finally(resetRegenerateGuard);
  };

  // Don't show actions for last assistant message when it's loading/streaming
  const isLastAssistantLoading =
    isLastAssistantMessage &&
    (status === "submitted" || status === "streaming");
  const formattedCreatedAt = formatMessageActionTimestamp(messageCreatedAt);
  const timestampDateTime =
    formattedCreatedAt !== null && typeof messageCreatedAt === "number"
      ? new Date(messageCreatedAt).toISOString()
      : null;
  const {
    shouldRenderActions,
    actionsAreVisible,
    shouldReserveTimestamp,
    timestampIsVisible,
  } = getMessageActionVisibility({
    isUser,
    isLastAssistantMessage,
    isMobile,
    isHovered,
    isEditing,
    isLastAssistantLoading,
    hasTimestamp: formattedCreatedAt !== null && timestampDateTime !== null,
  });

  return (
    <div
      className={cn(
        "group/message-actions mt-1 flex flex-wrap items-center gap-2 transition-opacity duration-200 ease-in-out",
        isUser ? "justify-end" : "justify-start",
        actionsAreVisible
          ? "opacity-100"
          : "pointer-events-none opacity-0 focus-within:pointer-events-auto focus-within:opacity-100",
      )}
    >
      {shouldRenderActions ? (
        <>
          {isUser && shouldReserveTimestamp && (
            <MessageTimestamp
              dateTime={timestampDateTime!}
              display={formattedCreatedAt!}
              isVisible={timestampIsVisible}
            />
          )}

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

          {!isUser && shouldReserveTimestamp && (
            <MessageTimestamp
              dateTime={timestampDateTime!}
              display={formattedCreatedAt!}
              isVisible={timestampIsVisible}
            />
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
