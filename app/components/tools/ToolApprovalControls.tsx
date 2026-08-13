"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  useAgentApproval,
  type AgentApprovalSendState,
} from "@/app/contexts/AgentApprovalContext";
import {
  parseAgentAutoReviewLifecycle,
  parseAgentAutoReviewSummary,
  type AgentAutoReviewLifecycle,
  type AgentAutoReviewSummary,
  type AgentToolApprovalOperation,
} from "@/types";

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
  autoReview?: AgentAutoReviewSummary;
  children?: (sendState: AgentApprovalSendState) => ReactNode;
};

type AgentAutoReviewLifecycleDataPart = {
  type?: unknown;
  data?: unknown;
};

export const AGENT_AUTO_REVIEW_DISPLAY_DELAY_MS = 450;

export type AgentAutoReviewLifecycleDisplay = "reviewing" | "needs_approval";

export const getStreamedAgentAutoReviewLifecycle = ({
  parts,
  toolCallId,
}: {
  parts: readonly unknown[];
  toolCallId: string;
}): AgentAutoReviewLifecycle | undefined => {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index] as AgentAutoReviewLifecycleDataPart;
    if (part.type !== "data-agent-auto-review-lifecycle") continue;
    const lifecycle = parseAgentAutoReviewLifecycle(part.data);
    if (lifecycle?.toolCallId === toolCallId) return lifecycle;
  }
  return undefined;
};

export const useAgentAutoReviewLifecycleDisplay = ({
  parts,
  toolCallId,
}: {
  parts: readonly unknown[];
  toolCallId: string;
}): AgentAutoReviewLifecycleDisplay | undefined => {
  const lifecycle = getStreamedAgentAutoReviewLifecycle({ parts, toolCallId });
  const lifecycleApprovalId = lifecycle?.approvalId;
  const lifecycleStartedAt = lifecycle?.startedAt;
  const lifecycleStatus = lifecycle?.status;
  const [display, setDisplay] = useState<{
    approvalId: string;
    status: AgentAutoReviewLifecycleDisplay;
  }>();
  const activeApprovalIdRef = useRef<string | undefined>(undefined);
  const reviewWasVisibleRef = useRef(false);

  useEffect(() => {
    if (
      !lifecycleApprovalId ||
      lifecycleStartedAt === undefined ||
      !lifecycleStatus
    ) {
      activeApprovalIdRef.current = undefined;
      reviewWasVisibleRef.current = false;
      return;
    }

    if (activeApprovalIdRef.current !== lifecycleApprovalId) {
      activeApprovalIdRef.current = lifecycleApprovalId;
      reviewWasVisibleRef.current = false;
    }

    if (lifecycleStatus === "reviewing") {
      const timeout = setTimeout(() => {
        reviewWasVisibleRef.current = true;
        setDisplay({
          approvalId: lifecycleApprovalId,
          status: "reviewing",
        });
      }, AGENT_AUTO_REVIEW_DISPLAY_DELAY_MS);
      return () => clearTimeout(timeout);
    }

    if (lifecycleStatus === "approved" || lifecycleStatus === "dismissed") {
      return;
    }

    if (!reviewWasVisibleRef.current) {
      return;
    }

    const showTimeout = setTimeout(() => {
      setDisplay({
        approvalId: lifecycleApprovalId,
        status: lifecycleStatus,
      });
    }, 0);
    return () => clearTimeout(showTimeout);
  }, [lifecycleApprovalId, lifecycleStartedAt, lifecycleStatus]);

  return lifecycle &&
    lifecycle.status !== "dismissed" &&
    display?.approvalId === lifecycle.approvalId &&
    display.status === lifecycle.status
    ? display.status
    : undefined;
};

export const getAgentAutoReviewDisplayState = (
  display: AgentAutoReviewLifecycle["status"] | undefined,
): { action: string; isShimmer: boolean } | undefined => {
  switch (display) {
    case "reviewing":
      return { action: "Reviewing", isShimmer: false };
    case "needs_approval":
      return { action: "Needs your approval", isShimmer: false };
    default:
      return undefined;
  }
};

type AgentAutoReviewDataPart = {
  type?: unknown;
  data?: {
    approvalId?: unknown;
    toolCallId?: unknown;
    autoReview?: unknown;
  };
};

export const getStreamedAgentAutoReviewSummary = ({
  parts,
  approvalId,
  toolCallId,
}: {
  parts: readonly unknown[];
  approvalId?: string;
  toolCallId: string;
}): AgentAutoReviewSummary | undefined => {
  if (!approvalId) return undefined;

  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index] as AgentAutoReviewDataPart;
    if (
      part.type !== "data-agent-auto-review" ||
      part.data?.approvalId !== approvalId ||
      part.data?.toolCallId !== toolCallId
    ) {
      continue;
    }
    return parseAgentAutoReviewSummary(part.data.autoReview);
  }

  return undefined;
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

export function getToolApprovalDisplayTarget({
  target,
}: {
  sendState: AgentApprovalSendState;
  target?: string;
}): string | undefined {
  return target;
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
  autoReview,
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
      autoReview,
    });
  }, [
    approvalId,
    autoReview,
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
