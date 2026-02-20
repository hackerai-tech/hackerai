"use client";

import { useEffect, useRef } from "react";
import TextareaAutosize from "react-textarea-autosize";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { useFileUpload } from "@/app/hooks/useFileUpload";
import {
  getDraftContentById,
  upsertDraft,
  removeDraft,
} from "@/lib/utils/client-storage";
import {
  countInputTokens,
  getMaxTokensForSubscription,
} from "@/lib/token-utils";
import { toast } from "sonner";
import type { ChatMode } from "@/types/chat";

export interface ChatInputTextareaProps {
  draftId: string;
  chatMode: ChatMode;
  onEnterSubmit: (e: React.FormEvent) => void;
  disabled?: boolean;
}

export function ChatInputTextarea({
  draftId,
  chatMode,
  onEnterSubmit,
  disabled = false,
}: ChatInputTextareaProps) {
  const { input, setInput, subscription } = useGlobalState();
  const { handlePasteEvent } = useFileUpload(chatMode);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load draft when draftId changes (chat switch or mount)
  useEffect(() => {
    const content = getDraftContentById(draftId);
    setInput(content || "");
  }, [draftId, setInput]);

  // Auto-save draft as user types with 500ms debounce
  useEffect(() => {
    const handle = window.setTimeout(() => {
      if (input.trim()) {
        upsertDraft(draftId, input);
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

      const pastedText = clipboardData.getData("text");
      if (!pastedText) {
        await handlePasteEvent(e);
        return;
      }

      const tokenCount = countInputTokens(pastedText, []);
      const maxTokens = getMaxTokensForSubscription(subscription);
      if (tokenCount > maxTokens) {
        e.preventDefault();
        const planText = subscription !== "free" ? "" : " (Free plan limit)";
        toast.error("Content is too long to paste", {
          description: `The content you're trying to paste is too large (${tokenCount.toLocaleString()} tokens). Please copy a smaller amount${planText}.`,
        });
        return;
      }

      await handlePasteEvent(e);
    };
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handlePasteEvent]);

  return (
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
