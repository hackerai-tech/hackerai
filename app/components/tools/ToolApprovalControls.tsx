"use client";

import { useEffect } from "react";
import { useAgentApproval } from "@/app/contexts/AgentApprovalContext";

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
    setActiveToolApprovalRequest,
    clearActiveToolApprovalRequest,
    toolApprovalSendStates,
  } = useAgentApproval();
  const sendState = approvalId
    ? (toolApprovalSendStates[approvalId] ?? "idle")
    : "idle";
  const isSettled = sendState === "approved" || sendState === "denied";

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

  return null;
}
