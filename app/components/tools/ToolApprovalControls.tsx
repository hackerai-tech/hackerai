"use client";

import { useEffect, useRef, type ReactNode } from "react";
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
    settleActiveToolApprovalRequest,
    toolApprovalSendStates,
  } = useAgentApproval();
  const sendState = approvalId
    ? (toolApprovalSendStates[approvalId] ?? "idle")
    : "idle";
  const isSettled = sendState === "approved" || sendState === "denied";
  const isSettledRef = useRef(isSettled);

  useEffect(() => {
    isSettledRef.current = isSettled;
  }, [isSettled]);

  useEffect(() => {
    if (!approvalId) {
      clearActiveToolApprovalRequest({ toolCallId });
      return;
    }
    if (isSettled) {
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

  useEffect(() => {
    if (!approvalId || !isSettled) return;
    settleActiveToolApprovalRequest({ approvalId, toolCallId });
  }, [approvalId, isSettled, settleActiveToolApprovalRequest, toolCallId]);

  useEffect(
    () => () => {
      if (approvalId && isSettledRef.current) {
        settleActiveToolApprovalRequest({ approvalId, toolCallId });
        return;
      }
      clearActiveToolApprovalRequest({ approvalId, toolCallId });
    },
    [
      approvalId,
      clearActiveToolApprovalRequest,
      settleActiveToolApprovalRequest,
      toolCallId,
    ],
  );

  return children?.(sendState) ?? null;
}
