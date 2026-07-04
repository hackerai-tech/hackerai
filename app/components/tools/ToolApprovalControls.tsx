"use client";

import { useEffect } from "react";
import { Check, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAgentApproval } from "@/app/contexts/AgentApprovalContext";
import type { AgentToolApprovalDecision } from "@/types";
import { toast } from "sonner";

type ToolApprovalControlsProps = {
  approvalId?: string;
  toolCallId: string;
  title: string;
  target?: string;
  detail?: string;
};

export function ToolApprovalControls({
  approvalId,
  toolCallId,
  title,
  target,
  detail,
}: ToolApprovalControlsProps) {
  const {
    session,
    sendToolApproval,
    setActiveToolApprovalRequest,
    clearActiveToolApprovalRequest,
    toolApprovalSendStates,
  } = useAgentApproval();
  const sendState = approvalId
    ? (toolApprovalSendStates[approvalId] ?? "idle")
    : "idle";
  const isBusy = sendState === "sending";
  const isSettled = sendState === "approved" || sendState === "denied";
  const canRespond = !!approvalId && !!session && !isBusy && !isSettled;

  useEffect(() => {
    if (!approvalId || isSettled) {
      clearActiveToolApprovalRequest({ approvalId, toolCallId });
      return;
    }

    setActiveToolApprovalRequest({
      approvalId,
      toolCallId,
      title,
      target,
      detail,
    });

    return () => {
      clearActiveToolApprovalRequest({ approvalId, toolCallId });
    };
  }, [
    approvalId,
    clearActiveToolApprovalRequest,
    detail,
    isSettled,
    setActiveToolApprovalRequest,
    target,
    title,
    toolCallId,
  ]);

  const submitDecision = async (decision: AgentToolApprovalDecision) => {
    if (!approvalId || !session || isBusy || isSettled) return;
    try {
      await sendToolApproval({
        approvalId,
        toolCallId,
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
    <div className="mt-2 flex items-center gap-2 pl-1">
      <Button
        type="button"
        size="xs"
        variant="default"
        disabled={!canRespond}
        onClick={() => void submitDecision("approve")}
        aria-label="Approve full access"
      >
        {isBusy ? <Loader2 className="animate-spin" /> : <Check />}
        {sendState === "approved" ? "Approved" : "Approve full access"}
      </Button>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        disabled={!canRespond}
        onClick={() => void submitDecision("deny")}
        aria-label="Deny approval"
      >
        <X />
        {sendState === "denied" ? "Denied" : "Deny"}
      </Button>
    </div>
  );
}
