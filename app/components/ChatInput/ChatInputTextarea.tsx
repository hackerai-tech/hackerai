"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
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
  onCommandKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  disabled?: boolean;
  minRows?: number;
  placeholder?: string;
  autoFocus?: boolean;
  onFocus?: () => void;
  onPointerDown?: () => void;
  onBlur?: (event: React.FocusEvent<HTMLTextAreaElement>) => void;
}

export function ChatInputTextarea({
  draftId,
  chatMode,
  onEnterSubmit,
  onCommandKeyDown,
  disabled = false,
  minRows = 1,
  placeholder,
  autoFocus = true,
  onFocus,
  onPointerDown,
  onBlur,
}: ChatInputTextareaProps) {
  const input = useComposerInput();
  const { setInput, getInput } = useComposerActions();
  const { subscription } = useGlobalState();
  const { handlePasteEvent, handlePastedTextAttachment } =
    useFileUpload(chatMode);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = useRef(input);
  const prevDraftIdRef = useRef(draftId);
  useEffect(() => {
    inputRef.current = input;
  });

  useEffect(() => {
    // Mobile composition starts with an explicit tap, without opening its
    // keyboard or Agent controls as soon as a chat mounts.
    if (autoFocus && !window.matchMedia("(max-width: 767px)").matches) {
      textareaRef.current?.focus();
    }
  }, [autoFocus]);

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

  // Save each committed edit so navigation or pagehide cannot cancel the
  // latest draft. Accepted submissions still clear it through setInput("").
  useEffect(() => {
    // Restoring a draft updates the provider in a layout effect. Ignore the
    // preceding render's value instead of overwriting that restored draft.
    if (input !== getInput()) return;
    if (input.trim()) {
      upsertDraft(draftId, input);
    } else if (hasDraftAttachmentsById(draftId)) {
      upsertDraft(draftId, "");
    } else {
      removeDraft(draftId);
    }
  }, [input, draftId, getInput]);

  // Handle paste events for file uploads and token validation
  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent) => {
      if (textareaRef.current !== document.activeElement) return;

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
              ? "Do anything"
              : "Ask, learn, brainstorm"
        }
        className="flex rounded-md border-input focus-visible:outline-none focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 overflow-hidden flex-1 bg-transparent p-0 pt-[1px] border-0 focus-visible:ring-0 focus-visible:ring-offset-0 w-full placeholder:text-muted-foreground text-base shadow-none resize-none min-h-[28px]"
        minRows={minRows}
        onFocus={onFocus}
        onPointerDown={onPointerDown}
        onBlur={onBlur}
        disabled={disabled}
        data-testid="chat-input"
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)
            return;
          onCommandKeyDown?.(e);
          if (e.defaultPrevented) return;
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onEnterSubmit(e);
          }
        }}
      />
    </div>
  );
}
