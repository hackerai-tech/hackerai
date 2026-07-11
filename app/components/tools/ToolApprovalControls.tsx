"use client";

import { useEffect, type ReactNode } from "react";
import {
  useAgentApproval,
  type AgentApprovalSendState,
} from "@/app/contexts/AgentApprovalContext";
import type { AgentToolApprovalOperation } from "@/types";

type ToolApprovalControlsProps = {
  approvalId?: string;
  toolCallId: string;
  title: string;
  target?: string;
  justification?: string;
  prefixRule?: string[];
  detail?: string;
  kind?: "terminal" | "file";
  operation?: AgentToolApprovalOperation;
  children?: (sendState: AgentApprovalSendState) => ReactNode;
};

export function getToolApprovalDisplayState({
  sendState,
  approvedAction,
  deniedAction,
}: {
  sendState: AgentApprovalSendState;
  approvedAction: string;
  deniedAction: string;
}) {
  switch (sendState) {
    case "sending":
      return { action: "Approving", isShimmer: true };
    case "approved":
      return { action: approvedAction, isShimmer: true };
    case "denied":
      return { action: deniedAction, isShimmer: false };
    default:
      return { action: "Awaiting approval", isShimmer: false };
  }
}

export function ToolApprovalControls({
  approvalId,
  toolCallId,
  title,
  target,
  justification,
  prefixRule,
  detail,
  kind,
  operation,
  children,
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
      justification,
      prefixRule,
      detail,
      kind,
      operation,
    });

    return () => {
      clearActiveToolApprovalRequest({ approvalId, toolCallId });
    };
  }, [
    approvalId,
    clearActiveToolApprovalRequest,
    detail,
    isSettled,
    justification,
    kind,
    operation,
    prefixRule,
    setActiveToolApprovalRequest,
    target,
    title,
    toolCallId,
  ]);

  return children?.(sendState) ?? null;
}
