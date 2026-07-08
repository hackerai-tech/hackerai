"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  CornerDownLeft,
  Loader2,
  Pencil,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  type ActiveAgentToolApprovalRequest,
  useAgentApproval,
} from "@/app/contexts/AgentApprovalContext";
import type {
  AgentToolApprovalDecision,
  AgentToolApprovalGrantKind,
} from "@/types";

type AgentApprovalPromptProps = {
  request: ActiveAgentToolApprovalRequest;
};

const APPROVAL_OPTIONS: Array<{
  id: "approve" | "target_prefix" | "deny_feedback";
  decision: AgentToolApprovalDecision;
  index: number;
}> = [
  {
    id: "approve",
    decision: "approve",
    index: 1,
  },
  {
    id: "target_prefix",
    decision: "approve",
    index: 2,
  },
  {
    id: "deny_feedback",
    decision: "deny",
    index: 3,
  },
];

const isPlainEnterKey = (event: {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}) =>
  event.key === "Enter" &&
  !event.altKey &&
  !event.ctrlKey &&
  !event.metaKey &&
  !event.shiftKey;

const isEditableKeyTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;

  const editableElement = target.closest("input, textarea, select");
  if (!editableElement) return false;

  if (editableElement instanceof HTMLInputElement) {
    return ![
      "button",
      "checkbox",
      "color",
      "file",
      "image",
      "radio",
      "range",
      "reset",
      "submit",
    ].includes(editableElement.type);
  }

  return true;
};

export function AgentApprovalPrompt({ request }: AgentApprovalPromptProps) {
  const { session, sendToolApproval, toolApprovalSendStates } =
    useAgentApproval();
  const formRef = useRef<HTMLFormElement | null>(null);
  const optionRefs = useRef<Array<HTMLElement | null>>([]);
  const feedbackInputRef = useRef<HTMLInputElement | null>(null);
  const [selectedOptionId, setSelectedOptionId] =
    useState<(typeof APPROVAL_OPTIONS)[number]["id"]>("approve");
  const [feedback, setFeedback] = useState("");
  const sendState = toolApprovalSendStates[request.approvalId] ?? "idle";
  const isSending = sendState === "sending";
  const isSettled = sendState === "approved" || sendState === "denied";
  const canSubmit = !!session && !isSending && !isSettled;
  const selectedOptionIndex = Math.max(
    0,
    APPROVAL_OPTIONS.findIndex((option) => option.id === selectedOptionId),
  );
  const approvalTarget = request.target?.trim() ?? "";
  const targetPrefix = getTargetPrefix({
    target: approvalTarget,
    kind: request.kind,
  });
  const targetKind = getTargetKind(request.kind);
  const targetPrefixLabel = getTargetPrefixLabel({
    prefix: targetPrefix,
    kind: request.kind,
  });

  const submitOption = useCallback(
    async (optionId: (typeof APPROVAL_OPTIONS)[number]["id"]) => {
      if (!canSubmit) return;
      const option =
        APPROVAL_OPTIONS.find(
          (approvalOption) => approvalOption.id === optionId,
        ) ?? APPROVAL_OPTIONS[0];
      try {
        await sendToolApproval({
          approvalId: request.approvalId,
          toolCallId: request.toolCallId,
          decision: option.decision,
          ...(option.id === "target_prefix" && targetPrefix && targetKind
            ? {
                grant: "target_prefix",
                targetPrefix,
                targetKind,
              }
            : {}),
          ...(option.id === "deny_feedback" && feedback.trim()
            ? { message: feedback.trim() }
            : {}),
        });
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Failed to send approval response.",
        );
      }
    },
    [
      canSubmit,
      feedback,
      request.approvalId,
      request.toolCallId,
      sendToolApproval,
      targetKind,
      targetPrefix,
    ],
  );

  const submitSkip = useCallback(async () => {
    try {
      await sendToolApproval({
        approvalId: request.approvalId,
        toolCallId: request.toolCallId,
        decision: "deny",
      });
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to send approval response.",
      );
    }
  }, [request.approvalId, request.toolCallId, sendToolApproval]);

  const selectOptionAtIndex = useCallback((index: number) => {
    const nextOption = APPROVAL_OPTIONS[index];
    if (!nextOption) return;
    setSelectedOptionId(nextOption.id);
    if (nextOption.id === "deny_feedback") {
      feedbackInputRef.current?.focus();
      return;
    }
    optionRefs.current[index]?.focus();
  }, []);

  const moveSelectedOption = useCallback(
    (direction: 1 | -1) => {
      const nextIndex = Math.min(
        Math.max(selectedOptionIndex + direction, 0),
        APPROVAL_OPTIONS.length - 1,
      );
      selectOptionAtIndex(nextIndex);
    },
    [selectOptionAtIndex, selectedOptionIndex],
  );

  const handlePromptKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveSelectedOption(event.key === "ArrowDown" ? 1 : -1);
      return;
    }

    if (!isPlainEnterKey(event)) return;
    if (
      event.target instanceof HTMLElement &&
      event.target.closest("[data-agent-approval-native-enter='true']")
    ) {
      return;
    }

    event.preventDefault();
    void submitOption(selectedOptionId);
  };

  useEffect(() => {
    const handleDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!canSubmit || event.defaultPrevented) return;
      if (
        event.target instanceof Node &&
        formRef.current?.contains(event.target)
      ) {
        return;
      }
      if (isEditableKeyTarget(event.target)) return;

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        moveSelectedOption(event.key === "ArrowDown" ? 1 : -1);
        return;
      }

      if (!isPlainEnterKey(event)) return;
      event.preventDefault();
      void submitOption(selectedOptionId);
    };

    document.addEventListener("keydown", handleDocumentKeyDown);
    return () => {
      document.removeEventListener("keydown", handleDocumentKeyDown);
    };
  }, [canSubmit, moveSelectedOption, selectedOptionId, submitOption]);

  return (
    <form
      ref={formRef}
      className="order-2 flex flex-col gap-2 rounded-[22px] border border-black/8 bg-input-chat px-3 py-3 shadow-[0px_12px_32px_0px_rgba(0,0,0,0.02)] dark:border-border sm:order-1"
      onKeyDown={handlePromptKeyDown}
      onSubmit={(event) => {
        event.preventDefault();
        void submitOption(selectedOptionId);
      }}
      data-testid="agent-approval-prompt"
    >
      <div className="flex flex-col gap-1 px-1">
        <div className="text-[15px] font-medium leading-5 text-foreground">
          {request.title}
        </div>
      </div>

      {approvalTarget ? (
        <div className="max-h-20 overflow-auto rounded-xl bg-black/5 px-3 py-2 font-mono text-sm leading-5 text-muted-foreground dark:bg-white/5">
          {request.target}
        </div>
      ) : null}

      <div
        role="radiogroup"
        aria-label="Agent approval options"
        className="flex flex-col gap-1"
      >
        {APPROVAL_OPTIONS.map((option, optionIndex) => {
          const selected = selectedOptionId === option.id;
          const canMoveUp = optionIndex > 0;
          const canMoveDown = optionIndex < APPROVAL_OPTIONS.length - 1;
          const label =
            option.id === "approve"
              ? "Yes"
              : option.id === "target_prefix"
                ? targetPrefixLabel
                : "No, and tell Codex what to do differently";
          const rowClassName = `flex min-h-11 w-full items-center gap-2 rounded-xl px-2.5 text-left transition-colors ${
            selected
              ? "bg-foreground/10 text-foreground"
              : "text-muted-foreground hover:bg-foreground/5"
          } ${canSubmit ? "" : "cursor-not-allowed opacity-60"}`;
          const iconClassName = `flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-sm font-medium ${
            selected
              ? "border-foreground bg-foreground text-background"
              : "border-border"
          }`;
          const arrows = selected ? (
            <span
              className="ml-auto flex shrink-0 items-center gap-1"
              aria-hidden="true"
              data-testid={`agent-approval-option-${option.id}-arrows`}
            >
              <ArrowUp
                className={`size-4 ${
                  canMoveUp ? "text-foreground/70" : "text-foreground/25"
                }`}
              />
              <ArrowDown
                className={`size-4 ${
                  canMoveDown ? "text-foreground/70" : "text-foreground/25"
                }`}
              />
            </span>
          ) : null;

          if (option.id === "deny_feedback") {
            return (
              <div
                key={option.id}
                ref={(node) => {
                  optionRefs.current[optionIndex] = node;
                }}
                role="radio"
                aria-checked={selected}
                aria-label={label}
                tabIndex={canSubmit ? 0 : -1}
                className={rowClassName}
                onClick={() => {
                  setSelectedOptionId(option.id);
                  feedbackInputRef.current?.focus();
                }}
                onKeyDown={(event) => {
                  if (!isPlainEnterKey(event)) return;
                  event.preventDefault();
                  event.stopPropagation();
                  setSelectedOptionId(option.id);
                  feedbackInputRef.current?.focus();
                }}
              >
                <span className={iconClassName} aria-hidden="true">
                  <Pencil className="h-3.5 w-3.5" />
                </span>
                <input
                  ref={feedbackInputRef}
                  type="text"
                  value={feedback}
                  disabled={!canSubmit}
                  className="min-w-0 flex-1 bg-transparent text-sm font-medium outline-none placeholder:text-muted-foreground"
                  aria-label={label}
                  placeholder={label}
                  data-agent-approval-native-enter="true"
                  onFocus={() => setSelectedOptionId(option.id)}
                  onChange={(event) => {
                    setSelectedOptionId(option.id);
                    setFeedback(event.target.value);
                  }}
                />
                {arrows}
              </div>
            );
          }

          return (
            <button
              key={option.id}
              ref={(node) => {
                optionRefs.current[optionIndex] = node;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={!canSubmit}
              className={rowClassName}
              onClick={() => setSelectedOptionId(option.id)}
              onKeyDown={(event) => {
                if (!isPlainEnterKey(event)) return;
                event.preventDefault();
                event.stopPropagation();
                setSelectedOptionId(option.id);
                void submitOption(option.id);
              }}
            >
              <span className={iconClassName} aria-hidden="true">
                {option.index}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {label}
              </span>
              {arrows}
            </button>
          );
        })}
      </div>

      <div className="flex items-center justify-end gap-2 pt-1">
        <Button
          type="button"
          variant="ghost"
          disabled={!canSubmit}
          size="sm"
          data-agent-approval-native-enter="true"
          onClick={() => void submitSkip()}
        >
          Skip
        </Button>
        <Button
          type="submit"
          disabled={!canSubmit}
          size="sm"
          data-agent-approval-native-enter="true"
        >
          {isSending ? <Loader2 className="animate-spin" /> : null}
          {isSettled ? "Submitted" : "Submit"}
          {!isSending && !isSettled ? <CornerDownLeft /> : null}
        </Button>
      </div>
    </form>
  );
}

const getTargetKind = (
  kind: ActiveAgentToolApprovalRequest["kind"],
): AgentToolApprovalGrantKind | undefined => {
  if (kind === "terminal") return "terminal_command";
  if (kind === "file") return "file_change";
  return undefined;
};

const getTargetPrefix = ({
  target,
  kind,
}: {
  target: string;
  kind: ActiveAgentToolApprovalRequest["kind"];
}): string => {
  if (!target) return "";
  if (kind === "terminal") return target.split(/\s+/)[0] ?? "";
  return target;
};

const getTargetPrefixLabel = ({
  prefix,
  kind,
}: {
  prefix: string;
  kind: ActiveAgentToolApprovalRequest["kind"];
}): string => {
  if (kind === "terminal" && prefix) {
    return `Yes, and don't ask again for commands that start with ${prefix}`;
  }
  if (kind === "file" && prefix) {
    return `Yes, and don't ask again for file changes to ${prefix}`;
  }
  return "Yes, and don't ask again for similar actions";
};
