import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import {
  ArrowUp,
  Square,
  MessageSquare,
  Infinity,
  ChevronDown,
} from "lucide-react";
import { useHotkeys } from "react-hotkeys-hook";
import TextareaAutosize from "react-textarea-autosize";
import { useGlobalState } from "../contexts/GlobalState";
import { redirectToPricing } from "../hooks/usePricingDialog";
import { TodoPanel } from "./TodoPanel";
import type { ChatStatus } from "@/types";
import { FileUploadPreview } from "./FileUploadPreview";
import { QueuedMessagesPanel } from "./QueuedMessagesPanel";
import { ScrollToBottomButton } from "./ScrollToBottomButton";
import { AttachmentButton } from "./AttachmentButton";
import { useFileUpload } from "../hooks/useFileUpload";
import { useEffect, useRef, useState } from "react";
import {
  countInputTokens,
  getMaxTokensForSubscription,
} from "@/lib/token-utils";
import { toast } from "sonner";
import {
  NULL_THREAD_DRAFT_ID,
  getDraftContentById,
  upsertDraft,
  removeDraft,
} from "@/lib/utils/client-storage";
import { RateLimitWarning } from "./RateLimitWarning";
import type { ChatMode, SubscriptionTier } from "@/types";

interface ChatInputProps {
  onSubmit: (e: React.FormEvent) => void;
  onStop: () => void;
  onSendNow: (messageId: string) => void;
  status: ChatStatus;
  isCentered?: boolean;
  hasMessages?: boolean;
  isAtBottom?: boolean;
  onScrollToBottom?: () => void;
  hideStop?: boolean;
  isNewChat?: boolean;
  clearDraftOnSubmit?: boolean;
  rateLimitWarning?: {
    remaining: number;
    resetTime: Date;
    mode: ChatMode;
    subscription: SubscriptionTier;
  };
  onDismissRateLimitWarning?: () => void;
}

export const ChatInput = ({
  onSubmit,
  onStop,
  onSendNow,
  status,
  isCentered = false,
  hasMessages = false,
  isAtBottom = true,
  onScrollToBottom,
  hideStop = false,
  isNewChat = false,
  clearDraftOnSubmit = true,
  rateLimitWarning,
  onDismissRateLimitWarning,
}: ChatInputProps) => {
  const {
    input,
    setInput,
    chatMode,
    setChatMode,
    uploadedFiles,
    isUploadingFiles,
    subscription,
    isCheckingProPlan,
    messageQueue,
    removeQueuedMessage,
  } = useGlobalState();
  const {
    fileInputRef,
    handleFileUploadEvent,
    handleRemoveFile,
    handleAttachClick,
    handlePasteEvent,
  } = useFileUpload();
  const [agentUpgradeDialogOpen, setAgentUpgradeDialogOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isGenerating = status === "submitted" || status === "streaming";

  // Fallback to 'ask' mode if user doesn't have pro plan and somehow has agent mode selected
  useEffect(() => {
    if (!isCheckingProPlan && subscription === "free" && chatMode === "agent") {
      setChatMode("ask");
    }
  }, [subscription, isCheckingProPlan, chatMode, setChatMode]);

  const handleAgentModeClick = () => {
    if (subscription !== "free") {
      setChatMode("agent");
    } else {
      setAgentUpgradeDialogOpen(true);
    }
  };

  const handleUpgradeClick = () => {
    // Close the upgrade dialog first
    setAgentUpgradeDialogOpen(false);
    // Navigate to pricing page
    redirectToPricing();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Allow submission if:
    // - (status is ready) OR (status is streaming AND in agent mode for queueing)
    // - files are not uploading
    // - there's text input or files attached
    const canSubmit =
      ((status === "ready" || (status === "streaming" && chatMode === "agent")) &&
        !isUploadingFiles &&
        (input.trim() || uploadedFiles.length > 0));

    if (canSubmit) {
      onSubmit(e);
      if (isNewChat && clearDraftOnSubmit) {
        // Remove draft immediately and clear input on next tick to avoid race with onSubmit
        removeDraft(NULL_THREAD_DRAFT_ID);
        setTimeout(() => setInput(""), 0);
      }
    }
  };

  // Handle keyboard shortcuts for stopping generation
  useHotkeys(
    "ctrl+c",
    (e) => {
      e.preventDefault();
      onStop();
    },
    {
      enabled: isGenerating && !hideStop,
      enableOnFormTags: true,
      enableOnContentEditable: true,
      preventDefault: true,
      description: "Stop AI generation",
    },
    [isGenerating, onStop],
  );

  // Load initial draft for new (non-id) chats
  useEffect(() => {
    if (!isNewChat) return;
    const content = getDraftContentById(NULL_THREAD_DRAFT_ID);
    if (content && !input) setInput(content);
  }, [isNewChat]);

  // Persist draft as user types for new (non-id) chats
  useEffect(() => {
    if (!isNewChat) return;
    const handle = window.setTimeout(() => {
      if (input) {
        upsertDraft(NULL_THREAD_DRAFT_ID, input);
      } else {
        removeDraft(NULL_THREAD_DRAFT_ID);
      }
    }, 600);

    return () => window.clearTimeout(handle);
  }, [input, isNewChat]);

  // Handle paste events for file uploads and token validation
  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent) => {
      // Only handle paste if the textarea is focused
      if (textareaRef.current === document.activeElement) {
        // Check if pasting text content
        const clipboardData = e.clipboardData;
        if (clipboardData) {
          const pastedText = clipboardData.getData("text");

          if (pastedText) {
            // Check token limit for the pasted text only based on user plan
            const tokenCount = countInputTokens(pastedText, []);
            const maxTokens = getMaxTokensForSubscription(subscription);
            if (tokenCount > maxTokens) {
              e.preventDefault();
              const planText =
                subscription !== "free" ? "" : " (Free plan limit)";
              toast.error("Content is too long to paste", {
                description: `The content you're trying to paste is too large (${tokenCount.toLocaleString()} tokens). Please copy a smaller amount${planText}.`,
              });
              return;
            }
          }
        }

        await handlePasteEvent(e);
        // If files were processed, the event.preventDefault() is already called
        // in handlePasteEvent, so no additional action needed here
      }
    };

    document.addEventListener("paste", handlePaste);
    return () => {
      document.removeEventListener("paste", handlePaste);
    };
  }, [handlePasteEvent]);

  return (
    <div className={`relative px-4 ${isCentered ? "" : "pb-3"}`}>
      <div className="mx-auto w-full max-w-full sm:max-w-[768px] sm:min-w-[390px] flex flex-col flex-1">
        {/* Rate Limit Warning */}
        {rateLimitWarning && onDismissRateLimitWarning && (
          <RateLimitWarning
            remaining={rateLimitWarning.remaining}
            resetTime={rateLimitWarning.resetTime}
            mode={rateLimitWarning.mode}
            subscription={rateLimitWarning.subscription}
            onDismiss={onDismissRateLimitWarning}
          />
        )}

        {/* Todo Panel */}
        <TodoPanel status={status} />

        {/* File Upload Preview */}
        {uploadedFiles && uploadedFiles.length > 0 && (
          <FileUploadPreview
            uploadedFiles={uploadedFiles}
            onRemoveFile={handleRemoveFile}
          />
        )}

        {/* Queued Messages Panel - only shown in Agent mode */}
        {messageQueue.length > 0 && chatMode === "agent" && (
          <QueuedMessagesPanel
            messages={messageQueue}
            onSendNow={onSendNow}
            onDelete={removeQueuedMessage}
            isStreaming={status === "streaming"}
          />
        )}

        {/* Hidden File Input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="*"
          multiple
          className="hidden"
          onChange={handleFileUploadEvent}
        />

        <div
          className={`flex flex-col gap-3 transition-all relative bg-input-chat py-3 max-h-[300px] shadow-[0px_12px_32px_0px_rgba(0,0,0,0.02)] border border-black/8 dark:border-border ${(uploadedFiles && uploadedFiles.length > 0) || (messageQueue.length > 0 && chatMode === "agent") ? "rounded-b-[22px] border-t-0" : "rounded-[22px]"}`}
        >
          <div className="overflow-y-auto pl-4 pr-2">
            <TextareaAutosize
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                chatMode === "agent"
                  ? "Hack, test, secure anything"
                  : "Ask, learn, brainstorm"
              }
              className="flex rounded-md border-input focus-visible:outline-none focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 overflow-hidden flex-1 bg-transparent p-0 pt-[1px] border-0 focus-visible:ring-0 focus-visible:ring-offset-0 w-full placeholder:text-muted-foreground text-[15px] shadow-none resize-none min-h-[28px]"
              rows={1}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit(e);
                }
              }}
            />
          </div>
          <div className="px-3 flex gap-2 items-center">
            {/* Attachment Button */}
            <AttachmentButton onAttachClick={handleAttachClick} />

            {/* Mode selector */}
            <div className="flex items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={`h-7 px-2 text-xs font-medium rounded-md focus-visible:ring-1 ${
                      chatMode === "agent"
                        ? "bg-red-500/10 text-red-700 hover:bg-red-500/20 dark:bg-red-400/10 dark:text-red-400 dark:hover:bg-red-400/20"
                        : "bg-muted hover:bg-muted/50"
                    }`}
                  >
                    {chatMode === "agent" ? (
                      <>
                        <Infinity className="w-3 h-3 mr-1" />
                        Agent
                      </>
                    ) : (
                      <>
                        <MessageSquare className="w-3 h-3 mr-1" />
                        Ask
                      </>
                    )}
                    <ChevronDown className="w-3 h-3 ml-1" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-54">
                  <DropdownMenuItem
                    onClick={() => setChatMode("ask")}
                    className="cursor-pointer"
                  >
                    <MessageSquare className="w-4 h-4 mr-2" />
                    <div className="flex flex-col">
                      <span className="font-medium">Ask</span>
                      <span className="text-xs text-muted-foreground">
                        Ask your hacking questions
                      </span>
                    </div>
                  </DropdownMenuItem>
                  {subscription !== "free" || isCheckingProPlan ? (
                    <DropdownMenuItem
                      onClick={() => setChatMode("agent")}
                      className="cursor-pointer"
                    >
                      <Infinity className="w-4 h-4 mr-2" />
                      <div className="flex flex-col">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">Agent</span>
                        </div>
                        <span className="text-xs text-muted-foreground">
                          Hack, test, secure anything
                        </span>
                      </div>
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem
                      onClick={handleAgentModeClick}
                      className="cursor-pointer"
                    >
                      <Infinity className="w-4 h-4 mr-2" />
                      <div className="flex flex-col flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">Agent</span>
                          <span className="flex items-center gap-1 rounded-full py-1 px-2 text-xs font-medium bg-premium-bg text-premium-text hover:bg-premium-hover border-0 transition-all duration-200">
                            PRO
                          </span>
                        </div>
                        <span className="text-xs text-muted-foreground">
                          Hack, test, secure anything
                        </span>
                      </div>
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div className="min-w-0 flex gap-2 ml-auto flex-shrink items-center">
              {isGenerating && !hideStop && chatMode === "agent" ? (
                // Agent mode during streaming: show both stop button and submit button
                <>
                  <TooltipPrimitive.Root>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        onClick={onStop}
                        variant="ghost"
                        className="rounded-full p-0 w-8 h-8 min-w-0 bg-red-500/10 hover:bg-red-500/20 text-red-700 dark:bg-red-400/10 dark:hover:bg-red-400/20 dark:text-red-400 focus-visible:ring-red-500"
                        aria-label="Stop generation"
                      >
                        <Square
                          className="w-[15px] h-[15px]"
                          fill="currentColor"
                        />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Stop (⌃C)</p>
                    </TooltipContent>
                  </TooltipPrimitive.Root>
                  <form onSubmit={handleSubmit}>
                    <TooltipPrimitive.Root>
                      <TooltipTrigger asChild>
                        <div className="inline-block">
                          <Button
                            type="submit"
                            disabled={
                              status === "submitted" ||
                              isUploadingFiles ||
                              (!input.trim() && uploadedFiles.length === 0)
                            }
                            variant="default"
                            className="rounded-full p-0 w-8 h-8 min-w-0 bg-red-500/10 hover:bg-red-500/20 text-red-700 dark:bg-red-400/10 dark:hover:bg-red-400/20 dark:text-red-400 focus-visible:ring-red-500"
                            aria-label="Queue message"
                          >
                            <ArrowUp size={15} strokeWidth={3} />
                          </Button>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>
                          {uploadedFiles.some((f) => f.error)
                            ? "Remove failed files to queue"
                            : isUploadingFiles
                              ? "File upload pending"
                              : "Queue message (⏎)"}
                        </p>
                      </TooltipContent>
                    </TooltipPrimitive.Root>
                  </form>
                </>
              ) : isGenerating && !hideStop ? (
                // Ask mode: show only stop button during streaming
                <TooltipPrimitive.Root>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      onClick={onStop}
                      variant="ghost"
                      className="rounded-full p-0 w-8 h-8 min-w-0 bg-muted hover:bg-muted/70 text-foreground"
                      aria-label="Stop generation"
                    >
                      <Square
                        className="w-[15px] h-[15px]"
                        fill="currentColor"
                      />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Stop (⌃C)</p>
                  </TooltipContent>
                </TooltipPrimitive.Root>
              ) : (
                // Not streaming: show only submit button
                <form onSubmit={handleSubmit}>
                  <TooltipPrimitive.Root>
                    <TooltipTrigger asChild>
                      <div className="inline-block">
                        <Button
                          type="submit"
                          disabled={
                            status !== "ready" ||
                            isUploadingFiles ||
                            (!input.trim() && uploadedFiles.length === 0)
                          }
                          variant="default"
                          className={`rounded-full p-0 w-8 h-8 min-w-0 ${
                            chatMode === "agent"
                              ? "bg-red-500/10 hover:bg-red-500/20 text-red-700 dark:bg-red-400/10 dark:hover:bg-red-400/20 dark:text-red-400 focus-visible:ring-red-500"
                              : ""
                          }`}
                          aria-label="Send message"
                        >
                          <ArrowUp size={15} strokeWidth={3} />
                        </Button>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>
                        {uploadedFiles.some((f) => f.error)
                          ? "Remove failed files to send"
                          : isUploadingFiles
                            ? "File upload pending"
                            : "Send (⏎)"}
                      </p>
                    </TooltipContent>
                  </TooltipPrimitive.Root>
                </form>
              )}
            </div>
          </div>
        </div>

        {/* ScrollToBottomButton positioned relative to input */}
        {onScrollToBottom && (
          <div className="absolute -top-16 left-1/2 -translate-x-1/2 z-40">
            <ScrollToBottomButton
              onClick={onScrollToBottom}
              hasMessages={hasMessages}
              isAtBottom={isAtBottom}
            />
          </div>
        )}
      </div>

      {/* Agent Upgrade Dialog */}
      <Dialog
        open={agentUpgradeDialogOpen}
        onOpenChange={setAgentUpgradeDialogOpen}
      >
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Upgrade plan</DialogTitle>
            <DialogDescription>
              Get access to Agent mode and unlock advanced hacking, testing, and
              security features with Pro.
            </DialogDescription>
          </DialogHeader>
          <Button onClick={handleUpgradeClick} className="w-full" size="lg">
            Upgrade plan
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
};
