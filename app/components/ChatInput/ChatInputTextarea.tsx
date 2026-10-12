"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useIsMobile } from "@/hooks/use-mobile";
import TextareaAutosize from "react-textarea-autosize";
import { useGlobalState } from "@/app/contexts/GlobalState";
import {
  useComposerActions,
  useComposerInput,
} from "@/app/contexts/ComposerState";
import { useFileUpload } from "@/app/hooks/useFileUpload";
import {
  getDraftContentById,
  hasDraftAttachmentsById,
  upsertDraft,
  removeDraft,
} from "@/lib/utils/client-storage";
import { getMaxTokensForSubscription } from "@/lib/token-limits";
import {
  getInputTokenLimitStatus,
  inputTokenCountCouldExceedLimit,
} from "@/lib/utils/client-token-validation";
import { toast } from "sonner";
import type { ChatMode } from "@/types/chat";
import { isAgentMode } from "@/lib/utils/mode-helpers";

export interface ChatInputTextareaProps {
  draftId: string;
  chatMode: ChatMode;
  onEnterSubmit: (e: React.FormEvent) => void;
  disabled?: boolean;
  minRows?: number;
  placeholder?: string;
  autoFocus?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  expandedActions?: ReactNode;
}

export function ChatInputTextarea({
  draftId,
  chatMode,
  onEnterSubmit,
  disabled = false,
  minRows = 1,
  placeholder,
  autoFocus = true,
  expanded = false,
  onExpandedChange,
  expandedActions,
}: ChatInputTextareaProps) {
  const input = useComposerInput();
  const { setInput } = useComposerActions();
  const { subscription } = useGlobalState();
  const { handlePasteEvent, handlePastedTextAttachment } =
    useFileUpload(chatMode);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const expandedTextareaRef = useRef<HTMLTextAreaElement>(null);
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const selectionRef = useRef({ start: 0, end: 0 });
  const isMobile = useIsMobile();
  const editorOpen = expanded && Boolean(isMobile);
  const showExpandButton = Boolean(
    isMobile && onExpandedChange && (input.match(/\n/g)?.length ?? 0) > 5,
  );
  const inputRef = useRef(input);
  const prevDraftIdRef = useRef(draftId);
  const inputPlaceholder =
    placeholder ??
    (chatMode === "agent" ? "Do anything" : "Ask, learn, brainstorm");

  useEffect(() => {
    if (expanded && isMobile === false) onExpandedChange?.(false);
  }, [expanded, isMobile, onExpandedChange]);

  const updateEditorViewport = useCallback(() => {
    const viewport = window.visualViewport;
    const container = editorContainerRef.current;
    if (!container || !viewport) return;
    container.style.height = `${viewport.height}px`;
    container.style.top = `${viewport.offsetTop}px`;
  }, []);
  const setEditorContainer = useCallback(
    (container: HTMLDivElement | null) => {
      editorContainerRef.current = container;
      // Radix mounts its portal after the opening render. Size it on attachment
      // as well, so an already-open keyboard is accounted for immediately.
      updateEditorViewport();
    },
    [updateEditorViewport],
  );

  // The visual viewport excludes the phone keyboard, unlike the layout viewport.
  useEffect(() => {
    if (!editorOpen) return;
    const viewport = window.visualViewport;
    updateEditorViewport();
    viewport?.addEventListener("resize", updateEditorViewport);
    viewport?.addEventListener("scroll", updateEditorViewport);
    return () => {
      viewport?.removeEventListener("resize", updateEditorViewport);
      viewport?.removeEventListener("scroll", updateEditorViewport);
    };
  }, [editorOpen, updateEditorViewport]);
  useEffect(() => {
    inputRef.current = input;
  });

  // Load draft when draftId changes (chat switch or mount)
  useLayoutEffect(() => {
    const prevDraftId = prevDraftIdRef.current;
    prevDraftIdRef.current = draftId;

    // When a new chat gets its real ID after the first response, preserve any
    // text the user typed during streaming rather than wiping it.
    if (prevDraftId === "new" && draftId !== "new") {
      if (inputRef.current.trim()) {
        upsertDraft(draftId, inputRef.current);
      }
      return;
    }

    const content = getDraftContentById(draftId);
    setInput(content || "");
  }, [draftId, setInput]);

  // Auto-save draft as user types with 500ms debounce
  useEffect(() => {
    const handle = window.setTimeout(() => {
      if (input.trim()) {
        upsertDraft(draftId, input);
      } else if (hasDraftAttachmentsById(draftId)) {
        upsertDraft(draftId, "");
      } else {
        removeDraft(draftId);
      }
    }, 500);
    return () => window.clearTimeout(handle);
  }, [input, draftId]);

  // Handle paste events for file uploads and token validation
  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent) => {
      const activeTextarea = [
        textareaRef.current,
        expandedTextareaRef.current,
      ].find((textarea) => textarea && textarea === document.activeElement);
      if (!activeTextarea) return;

      const clipboardData = e.clipboardData;
      if (!clipboardData) {
        await handlePasteEvent(e);
        return;
      }

      const handledAsFile = await handlePasteEvent(e);
      if (handledAsFile) {
        return;
      }

      const pastedText = clipboardData.getData("text");
      if (!pastedText) {
        return;
      }

      const maxTokens = getMaxTokensForSubscription(subscription, {
        mode: chatMode,
      });
      if (!inputTokenCountCouldExceedLimit(pastedText, [], maxTokens)) {
        await handlePasteEvent(e);
        return;
      }

      // Async tokenization cannot cancel a native paste after dispatch ends.
      // Intercept only potentially oversized content, then manually insert it
      // below when exact tokenization shows that it fits.
      e.preventDefault();
      const tokenLimitStatus = await getInputTokenLimitStatus(
        pastedText,
        [],
        maxTokens,
      );
      if (tokenLimitStatus.exceedsLimit) {
        if (subscription !== "free" && isAgentMode(chatMode)) {
          await handlePastedTextAttachment(pastedText);
          return;
        }

        const planText = subscription !== "free" ? "" : " (Free plan limit)";
        toast.error("Content is too long to paste", {
          description: `The content you're trying to paste is too large (${tokenLimitStatus.tokenCount.toLocaleString()} tokens). Please copy a smaller amount${planText}.`,
        });
        return;
      }

      const textarea = activeTextarea;
      const currentInput = inputRef.current;
      const selectionStart = textarea?.selectionStart ?? currentInput.length;
      const selectionEnd = textarea?.selectionEnd ?? selectionStart;
      const nextInput =
        currentInput.slice(0, selectionStart) +
        pastedText +
        currentInput.slice(selectionEnd);
      const nextCursorPosition = selectionStart + pastedText.length;

      selectionRef.current = {
        start: nextCursorPosition,
        end: nextCursorPosition,
      };
      setInput(nextInput);
      requestAnimationFrame(() => {
        textarea?.focus();
        textarea?.setSelectionRange(nextCursorPosition, nextCursorPosition);
      });
    };
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [
    chatMode,
    handlePasteEvent,
    handlePastedTextAttachment,
    setInput,
    subscription,
  ]);

  return (
    <div className="relative overflow-y-auto pl-4 pr-2">
      <TextareaAutosize
        ref={textareaRef}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder={inputPlaceholder}
        className={`flex rounded-md border-input focus-visible:outline-none focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 overflow-hidden flex-1 bg-transparent p-0 pt-[1px] border-0 focus-visible:ring-0 focus-visible:ring-offset-0 w-full placeholder:text-muted-foreground text-base shadow-none resize-none min-h-[28px] ${showExpandButton ? "pr-10" : ""}`}
        minRows={minRows}
        autoFocus={autoFocus}
        disabled={disabled}
        data-testid="chat-input"
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onEnterSubmit(e);
          }
        }}
      />
      {showExpandButton && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute right-2 top-0 h-8 w-8 rounded-full text-muted-foreground"
          aria-label="Expand message editor"
          disabled={disabled}
          onClick={() => {
            selectionRef.current = {
              start: textareaRef.current?.selectionStart ?? input.length,
              end: textareaRef.current?.selectionEnd ?? input.length,
            };
            onExpandedChange?.(true);
          }}
        >
          <Maximize2 className="h-4 w-4" />
        </Button>
      )}
      <Dialog open={editorOpen} onOpenChange={onExpandedChange}>
        <DialogContent
          ref={setEditorContainer}
          showCloseButton={false}
          aria-describedby={undefined}
          className="left-0 top-0 flex h-dvh max-w-none translate-x-0 translate-y-0 flex-col gap-3 rounded-none border-0 bg-input-chat p-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] shadow-none duration-0 data-[state=open]:animate-none data-[state=closed]:animate-none sm:max-w-none"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            const textarea = expandedTextareaRef.current;
            textarea?.focus({ preventScroll: true });
            textarea?.setSelectionRange(
              selectionRef.current.start,
              selectionRef.current.end,
            );
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            textareaRef.current?.focus({ preventScroll: true });
            textareaRef.current?.setSelectionRange(
              selectionRef.current.start,
              selectionRef.current.end,
            );
          }}
        >
          <div className="flex shrink-0 items-center justify-between">
            <DialogTitle className="text-sm font-medium text-muted-foreground">
              Edit message
            </DialogTitle>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Collapse message editor"
              onClick={() => onExpandedChange?.(false)}
            >
              <Minimize2 className="h-4 w-4" />
            </Button>
          </div>
          <textarea
            ref={expandedTextareaRef}
            aria-label="Message"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onSelect={(e) => {
              selectionRef.current = {
                start: e.currentTarget.selectionStart,
                end: e.currentTarget.selectionEnd,
              };
            }}
            placeholder={inputPlaceholder}
            disabled={disabled}
            className="min-h-0 w-full flex-1 resize-none overflow-y-auto bg-transparent text-base leading-relaxed placeholder:text-muted-foreground focus-visible:outline-none"
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                (e.metaKey || e.ctrlKey) &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                onEnterSubmit(e);
              }
            }}
          />
          <div className="flex shrink-0 items-center justify-end">
            {expandedActions}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
