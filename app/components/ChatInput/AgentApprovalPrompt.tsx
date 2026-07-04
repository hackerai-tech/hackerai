"use client";

import { useState } from "react";
import { Check, CornerDownLeft, Loader2, X } from "lucide-react";
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

export function AgentApprovalPrompt({ request }: AgentApprovalPromptProps) {
  const { session, sendToolApproval, toolApprovalSendStates } =
    useAgentApproval();
  const [selectedDecision, setSelectedDecision] =
    useState<AgentToolApprovalDecision>("approve");
  const sendState = toolApprovalSendStates[request.approvalId] ?? "idle";
  const isSending = sendState === "sending";
  const isSettled = sendState === "approved" || sendState === "denied";
  const canSubmit = !!session && !isSending && !isSettled;

  const submitDecision = async (decision: AgentToolApprovalDecision) => {
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
  };

  return (
    <form
      className="order-2 sm:order-1 flex flex-col gap-3 rounded-[22px] border border-black/8 bg-input-chat p-4 shadow-[0px_12px_32px_0px_rgba(0,0,0,0.02)] dark:border-border"
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
        {APPROVAL_OPTIONS.map((option) => {
          const selected = selectedDecision === option.decision;
          const OptionIcon = option.decision === "approve" ? Check : X;
          return (
            <button
              key={option.decision}
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
              <span className="flex min-w-0 flex-col">
                <span className="text-sm font-medium">{option.label}</span>
                <span className="text-xs text-muted-foreground">
                  {option.description}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={!canSubmit}
          onClick={() => void submitDecision("deny")}
        >
          Skip
        </Button>
        <Button type="submit" disabled={!canSubmit}>
          {isSending ? <Loader2 className="animate-spin" /> : null}
          {isSettled ? "Submitted" : "Submit"}
          {!isSending && !isSettled ? <CornerDownLeft /> : null}
        </Button>
      </div>
    </form>
  );
}
