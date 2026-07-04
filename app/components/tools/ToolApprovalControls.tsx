"use client";

import { useState } from "react";
import { Check, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAgentApproval } from "@/app/contexts/AgentApprovalContext";
import type { AgentToolApprovalDecision } from "@/types";
import { toast } from "sonner";

type ApprovalSendState = "idle" | "sending" | "approved" | "denied";

type ToolApprovalControlsProps = {
  approvalId?: string;
  toolCallId: string;
};

export function ToolApprovalControls({
  approvalId,
  toolCallId,
}: ToolApprovalControlsProps) {
  const { session, sendToolApproval } = useAgentApproval();
  const [sendState, setSendState] = useState<ApprovalSendState>("idle");
  const isBusy = sendState === "sending";
  const isSettled = sendState === "approved" || sendState === "denied";
  const canRespond = !!approvalId && !!session && !isBusy && !isSettled;

  const submitDecision = async (decision: AgentToolApprovalDecision) => {
    if (!approvalId || !session || isBusy || isSettled) return;
    setSendState("sending");
    try {
      await sendToolApproval({
        approvalId,
        toolCallId,
        decision,
      });
      setSendState(decision === "approve" ? "approved" : "denied");
    } catch (error) {
      setSendState("idle");
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
