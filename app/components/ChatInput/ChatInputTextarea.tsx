"use client";

import { useEffect, useId, useLayoutEffect, useRef } from "react";
import TextareaAutosize from "react-textarea-autosize";
import { useGlobalState } from "@/app/contexts/GlobalState";
import {
  useComposerActions,
  useComposerInput,
} from "@/app/contexts/ComposerState";
import { useFileUpload } from "@/app/hooks/useFileUpload";
import {
  getDraftContentById,
  isDraftGoalModeById,
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
import { useCommittedRef } from "@/app/hooks/useLatestRef";
import { recordComposerChange } from "@/lib/posthog/composer-change-diagnostics";
import { MAX_AGENT_USER_REPLY_LENGTH } from "@/lib/chat/agent-user-wait";

export interface ChatInputTextareaProps {
  answerInput?: { value: string; onChange: (value: string) => void };
  prediction?: string;
  onAcceptPrediction?: () => boolean;
  onPredictionExposed?: () => void;
  onPredictionTyping?: () => void;
  composerFocused?: boolean;
  onDismissPrediction?: () => void;
  composerRef?: React.RefObject<HTMLTextAreaElement | null>;
  draftId: string;
  chatMode: ChatMode;
  onEnterSubmit: (e: React.FormEvent) => void;
  onCommandKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  disabled?: boolean;
  minRows?: number;
  placeholder?: string;
  autoFocus?: boolean;
  describedBy?: string;
  isReplyingToAgent?: boolean;
  onFocus?: () => void;
  onPointerDown?: () => void;
  onBlur?: (event: React.FocusEvent<HTMLTextAreaElement>) => void;
}

export function ChatInputTextarea({
  answerInput,
  prediction,
  onAcceptPrediction,
  onPredictionExposed,
  onPredictionTyping,
  composerFocused = false,
  onDismissPrediction,
  composerRef,
  draftId,
  chatMode,
  onEnterSubmit,
  onCommandKeyDown,
  disabled = false,
  minRows = 1,
  placeholder,
  autoFocus = true,
  describedBy,
  isReplyingToAgent = false,
  onFocus,
  onPointerDown,
  onBlur,
}: ChatInputTextareaProps) {
  const predictionDescriptionId = useId();
  const hasAnswerInput = !!answerInput;
  const composerInput = useComposerInput();
  const input = answerInput?.value ?? composerInput;
  const { setInput, getInput } = useComposerActions();
  const { subscription } = useGlobalState();
  const { handlePasteEvent, handlePastedTextAttachment } =
    useFileUpload(chatMode);
  const localTextareaRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = composerRef ?? localTextareaRef;
  const exposed = useCommittedRef(onPredictionExposed);
  const activePrediction = input === "" && !disabled ? prediction : undefined;
  const defaultPlaceholder =
    placeholder ??
    (chatMode === "agent" ? "Do anything" : "Ask, learn, brainstorm");
  const inputRef = useRef(input);
  const prevDraftIdRef = useRef(draftId);
  useEffect(() => {
    inputRef.current = input;
  });

  useEffect(() => {
    if (!activePrediction || !textareaRef.current) return;
    let visible = false;
    const record = () => {
      if (visible && document.visibilityState === "visible")
        exposed.current?.();
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting && entry.intersectionRatio >= 1;
        record();
      },
      { threshold: 1 },
    );
    observer.observe(textareaRef.current);
    document.addEventListener("visibilitychange", record);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", record);
    };
  }, [activePrediction, exposed, textareaRef]);

  const acceptPrediction = () => {
    if (!onAcceptPrediction?.()) return false;
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      textarea?.focus({ preventScroll: true });
      textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
    });
    return true;
  };

  useEffect(() => {
    // Mobile composition starts with an explicit tap, without opening its
    // keyboard or Agent controls as soon as a chat mounts.
    if (autoFocus && !window.matchMedia("(max-width: 767px)").matches) {
      textareaRef.current?.focus();
    }
  }, [autoFocus, textareaRef]);

  // Load draft when draftId changes (chat switch or mount)
  useLayoutEffect(() => {
    if (hasAnswerInput) return;
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
  }, [draftId, setInput, hasAnswerInput]);

  // Save each committed edit so navigation or pagehide cannot cancel the
  // latest draft. Accepted submissions still clear it through setInput("").
  useEffect(() => {
    // Restoring a draft updates the provider in a layout effect. Ignore the
    // preceding render's value instead of overwriting that restored draft.
    if (answerInput || input !== getInput()) return;
    if (input.trim()) {
      upsertDraft(draftId, input);
    } else if (
      hasDraftAttachmentsById(draftId) ||
      isDraftGoalModeById(draftId)
    ) {
      upsertDraft(draftId, "");
    } else {
      removeDraft(draftId);
    }
  }, [input, draftId, getInput, answerInput]);

  // Handle paste events for file uploads and token validation
  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent) => {
      if (textareaRef.current !== document.activeElement) return;

      const clipboardData = e.clipboardData;
      if (isReplyingToAgent) {
        const hasFile = Array.from(clipboardData?.items ?? []).some(
          (item) => item.kind === "file",
        );
        if (hasFile) {
          e.preventDefault();
          toast.info("Replies are text only for now");
          return;
        }
        const pastedText = clipboardData?.getData("text") ?? "";
        const textarea = textareaRef.current;
        const nextLength =
          inputRef.current.length -
          ((textarea?.selectionEnd ?? 0) - (textarea?.selectionStart ?? 0)) +
          pastedText.length;
        if (nextLength > MAX_AGENT_USER_REPLY_LENGTH) {
          e.preventDefault();
          toast.error("Reply is too long", {
            description: `Keep your reply under ${MAX_AGENT_USER_REPLY_LENGTH.toLocaleString()} characters.`,
          });
        }
        return;
      }
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
    getInput,
    handlePasteEvent,
    handlePastedTextAttachment,
    isReplyingToAgent,
    setInput,
    textareaRef,
    subscription,
  ]);

  return (
    <div className="overflow-y-auto pl-4 pr-2">
      <div className="relative">
        <TextareaAutosize
          ref={textareaRef}
          maxLength={
            isReplyingToAgent ? MAX_AGENT_USER_REPLY_LENGTH : undefined
          }
          value={input}
          onChange={(e) => {
            // Record before setInput: React can throw synchronously in the setter.
            recordComposerChange(e.nativeEvent);
            if (e.target.value !== "") onPredictionTyping?.();
            if (answerInput) answerInput.onChange(e.target.value);
            else setInput(e.target.value);
          }}
          aria-label={defaultPlaceholder}
          aria-describedby={
            describedBy ??
            (activePrediction ? predictionDescriptionId : undefined)
          }
          placeholder={activePrediction ?? defaultPlaceholder}
          className={`flex rounded-md border-input focus-visible:outline-none focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 overflow-hidden flex-1 bg-transparent p-0 pt-[1px] border-0 focus-visible:ring-0 focus-visible:ring-offset-0 w-full placeholder:text-muted-foreground text-base shadow-none resize-none min-h-[28px] ${activePrediction ? "pr-14 ph-no-capture ph-mask" : ""}`}
          minRows={minRows}
          onFocus={onFocus}
          onPointerDown={onPointerDown}
          onBlur={onBlur}
          disabled={disabled}
          data-testid="chat-input"
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)
              return;
            if (
              activePrediction &&
              getInput() === "" &&
              !e.nativeEvent.isComposing &&
              e.nativeEvent.keyCode !== 229 &&
              !e.shiftKey &&
              !e.altKey &&
              !e.ctrlKey &&
              !e.metaKey
            ) {
              if (e.key === "Tab" && acceptPrediction()) {
                e.preventDefault();
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                onDismissPrediction?.();
                return;
              }
            }
            onCommandKeyDown?.(e);
            if (e.defaultPrevented) return;
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing &&
              e.nativeEvent.keyCode !== 229
            ) {
              e.preventDefault();
              onEnterSubmit(e);
            }
          }}
        />
        {activePrediction && (
          <kbd
            aria-hidden="true"
            className={`pointer-events-none absolute right-0 top-0 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground ${composerFocused ? "inline-flex" : "hidden"}`}
          >
            Tab
          </kbd>
        )}
      </div>
      {activePrediction && (
        <span
          id={predictionDescriptionId}
          className="sr-only ph-no-capture ph-mask"
        >
          Suggested next message: {activePrediction}. Press Tab to add it to the
          composer, or Escape to dismiss. Review and send when ready.
        </span>
      )}
    </div>
  );
}
