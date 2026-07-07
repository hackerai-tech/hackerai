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
  Check,
  CornerDownLeft,
  Loader2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  type ActiveAgentToolApprovalRequest,
  useAgentApproval,
} from "@/app/contexts/AgentApprovalContext";
import type { AgentToolApprovalDecision } from "@/types";

type AgentApprovalPromptProps = {
  request: ActiveAgentToolApprovalRequest;
};

const APPROVAL_OPTIONS: Array<{
  decision: AgentToolApprovalDecision;
  label: string;
  description: string;
  index: number;
}> = [
  {
    decision: "approve",
    label: "Approve full access",
    description: "Allow this command or file change to run.",
    index: 1,
  },
  {
    decision: "deny",
    label: "Deny",
    description: "Stop this action and let the agent recover.",
    index: 2,
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
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [selectedDecision, setSelectedDecision] =
    useState<AgentToolApprovalDecision>("approve");
  const sendState = toolApprovalSendStates[request.approvalId] ?? "idle";
  const isSending = sendState === "sending";
  const isSettled = sendState === "approved" || sendState === "denied";
  const canSubmit = !!session && !isSending && !isSettled;
  const selectedOptionIndex = Math.max(
    0,
    APPROVAL_OPTIONS.findIndex(
      (option) => option.decision === selectedDecision,
    ),
  );

  const submitDecision = useCallback(
    async (decision: AgentToolApprovalDecision) => {
      if (!canSubmit) return;
      try {
        await sendToolApproval({
          approvalId: request.approvalId,
          toolCallId: request.toolCallId,
          decision,
        });
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Failed to send approval response.",
        );
      }
    },
    [canSubmit, request.approvalId, request.toolCallId, sendToolApproval],
  );

  const selectOptionAtIndex = useCallback((index: number) => {
    const nextOption = APPROVAL_OPTIONS[index];
    if (!nextOption) return;
    setSelectedDecision(nextOption.decision);
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
    void submitDecision(selectedDecision);
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
      void submitDecision(selectedDecision);
    };

    document.addEventListener("keydown", handleDocumentKeyDown);
    return () => {
      document.removeEventListener("keydown", handleDocumentKeyDown);
    };
  }, [canSubmit, moveSelectedOption, selectedDecision, submitDecision]);

  return (
    <form
      ref={formRef}
      className="order-2 sm:order-1 flex flex-col gap-3 rounded-[22px] border border-black/8 bg-input-chat p-4 shadow-[0px_12px_32px_0px_rgba(0,0,0,0.02)] dark:border-border"
      onKeyDown={handlePromptKeyDown}
      onSubmit={(event) => {
        event.preventDefault();
        void submitDecision(selectedDecision);
      }}
      data-testid="agent-approval-prompt"
    >
      <div className="flex flex-col gap-1">
        <div className="text-[15px] font-medium leading-snug text-foreground">
          {request.title}
        </div>
        {request.detail ? (
          <div className="text-sm leading-snug text-muted-foreground">
            {request.detail}
          </div>
        ) : null}
      </div>

      {request.target ? (
        <div className="max-h-28 overflow-auto rounded-xl bg-black/5 px-3 py-2 font-mono text-sm leading-relaxed text-muted-foreground dark:bg-white/5">
          {request.target}
        </div>
      ) : null}

      <div
        role="radiogroup"
        aria-label="Agent approval options"
        className="flex flex-col gap-1"
      >
        {APPROVAL_OPTIONS.map((option, optionIndex) => {
          const selected = selectedDecision === option.decision;
          const OptionIcon = option.decision === "approve" ? Check : X;
          const canMoveUp = optionIndex > 0;
          const canMoveDown = optionIndex < APPROVAL_OPTIONS.length - 1;
          return (
            <button
              key={option.decision}
              ref={(node) => {
                optionRefs.current[optionIndex] = node;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={!canSubmit}
              className={`flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left transition-colors ${
                selected
                  ? "bg-foreground/10 text-foreground"
                  : "text-muted-foreground hover:bg-foreground/5"
              } disabled:cursor-not-allowed disabled:opacity-60`}
              onClick={() => setSelectedDecision(option.decision)}
              onKeyDown={(event) => {
                if (!isPlainEnterKey(event)) return;
                event.preventDefault();
                event.stopPropagation();
                setSelectedDecision(option.decision);
                void submitDecision(option.decision);
              }}
            >
              <span
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-sm font-medium ${
                  selected
                    ? "border-foreground bg-foreground text-background"
                    : "border-border"
                }`}
                aria-hidden="true"
              >
                {selected ? <OptionIcon className="h-4 w-4" /> : option.index}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">
                  {option.label}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {option.description}
                </span>
              </span>
              {selected ? (
                <span
                  className="ml-auto flex shrink-0 items-center gap-1"
                  aria-hidden="true"
                  data-testid={`agent-approval-option-${option.decision}-arrows`}
                >
                  <ArrowUp
                    className={`size-4 ${
                      canMoveUp ? "text-foreground/70" : "text-foreground/25"
                    }`}
                  />
                  <ArrowDown
                    className={`size-4 ${
                      canMoveDown
                        ? "text-foreground/70"
                        : "text-foreground/25"
                    }`}
                  />
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={!canSubmit}
          data-agent-approval-native-enter="true"
          onClick={() => void submitDecision("deny")}
        >
          Skip
        </Button>
        <Button
          type="submit"
          disabled={!canSubmit}
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
