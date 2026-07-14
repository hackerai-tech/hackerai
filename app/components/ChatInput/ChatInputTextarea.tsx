"use client";

import { useEffect, useRef } from "react";
import TextareaAutosize from "react-textarea-autosize";
import { useGlobalState } from "@/app/contexts/GlobalState";
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

export interface ChatInputTextareaProps {
  draftId: string;
  chatMode: ChatMode;
  onEnterSubmit: (e: React.FormEvent) => void;
  disabled?: boolean;
  minRows?: number;
  placeholder?: string;
  autoFocus?: boolean;
}

export function ChatInputTextarea({
  draftId,
  chatMode,
  onEnterSubmit,
  disabled = false,
  minRows = 1,
  placeholder,
  autoFocus = true,
}: ChatInputTextareaProps) {
  const { input, setInput, subscription } = useGlobalState();
  const { handlePasteEvent, handlePastedTextAttachment } =
    useFileUpload(chatMode);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = useRef(input);
  const prevDraftIdRef = useRef(draftId);
  useEffect(() => {
    inputRef.current = input;
  });

  // Load draft when draftId changes (chat switch or mount)
  useEffect(() => {
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
      if (textareaRef.current !== document.activeElement) return;

      const clipboardData = e.clipboardData;
      if (!clipboardData) {
        await handlePasteEvent(e);
        return;
      }

      const hasClipboardFiles = Array.from(clipboardData.items ?? []).some(
        (item) => item.kind === "file",
      );
      if (hasClipboardFiles) {
        await handlePasteEvent(e);
        return;
      }

      const pastedText = clipboardData.getData("text");
      if (!pastedText) {
        await handlePasteEvent(e);
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
        if (subscription !== "free") {
          await handlePastedTextAttachment(pastedText);
          return;
        }

        const planText = subscription !== "free" ? "" : " (Free plan limit)";
        toast.error("Content is too long to paste", {
          description: `The content you're trying to paste is too large (${tokenLimitStatus.tokenCount.toLocaleString()} tokens). Please copy a smaller amount${planText}.`,
        });
        return;
      }

      const textarea = textareaRef.current;
      const currentInput = inputRef.current;
      const selectionStart = textarea?.selectionStart ?? currentInput.length;
      const selectionEnd = textarea?.selectionEnd ?? selectionStart;
      const nextInput =
        currentInput.slice(0, selectionStart) +
        pastedText +
        currentInput.slice(selectionEnd);
      const nextCursorPosition = selectionStart + pastedText.length;

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
    <div className="overflow-y-auto pl-4 pr-2">
      <TextareaAutosize
        ref={textareaRef}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder={
          placeholder !== undefined
            ? placeholder
            : chatMode === "agent"
              ? "Hack, test, secure anything"
              : "Ask, learn, brainstorm"
        }
        className="flex rounded-md border-input focus-visible:outline-none focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 overflow-hidden flex-1 bg-transparent p-0 pt-[1px] border-0 focus-visible:ring-0 focus-visible:ring-offset-0 w-full placeholder:text-muted-foreground text-base shadow-none resize-none min-h-[28px]"
        minRows={minRows}
        autoFocus={autoFocus}
        disabled={disabled}
        data-testid="chat-input"
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onEnterSubmit(e);
          }
        }}
      />
    </div>
  );
}
