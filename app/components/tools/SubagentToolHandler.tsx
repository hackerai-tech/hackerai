"use client";

import { memo, useMemo } from "react";
import { Bot } from "lucide-react";
import type { UIMessage } from "@ai-sdk/react";

import ToolBlock from "@/components/ui/tool-block";
import type { ChatStatus, SidebarSubagents } from "@/types/chat";
import { isSidebarSubagents } from "@/types/chat";
import { useToolSidebar } from "@/app/hooks/useToolSidebar";

type LifecyclePart = {
  type: "data-subagent-lifecycle";
  data?: {
    subagent_id?: string;
    parent_message_id?: string;
    parent_tool_call_id?: string;
    agent_name?: string;
    status?: string;
  };
};

const nameForAgentId = (
  message: UIMessage,
  agentId: string | undefined,
): string | undefined => {
  if (!agentId) return undefined;
  for (const candidate of message.parts as any[]) {
    if (
      candidate?.type === "data-subagent-lifecycle" &&
      candidate?.data?.subagent_id === agentId &&
      candidate?.data?.agent_name
    ) {
      return candidate.data.agent_name;
    }
    if (
      candidate?.type === "tool-create_agent" &&
      candidate?.output?.agent_id === agentId &&
      candidate?.output?.name
    ) {
      return candidate.output.name;
    }
  }
  return undefined;
};

export const SubagentToolHandler = memo(function SubagentToolHandler({
  message,
  part,
  status,
}: {
  message: UIMessage;
  part: any;
  status: ChatStatus;
}) {
  const { toolCallId, state, input, output, errorText, type } = part;
  const lifecycle = (message.parts as any[]).find(
    (candidate: any) =>
      candidate?.type === "data-subagent-lifecycle" &&
      candidate?.data?.parent_tool_call_id === toolCallId,
  ) as LifecyclePart | undefined;
  const agentId =
    lifecycle?.data?.subagent_id ??
    output?.agent_id ??
    output?.target_agent_id ??
    input?.target_agent_id;
  const legacyTitle =
    input?.profile_input?.candidate?.title ??
    input?.objective ??
    "Delegated task";
  const agentName =
    lifecycle?.data?.agent_name ??
    output?.name ??
    output?.target_agent_name ??
    output?.agent_name ??
    input?.name ??
    nameForAgentId(message, agentId) ??
    (type === "tool-delegate_task" ? legacyTitle : "Subagent");
  const parentMessageId = lifecycle?.data?.parent_message_id ?? message.id;
  const isCreate = type === "tool-create_agent";
  const isSend = type === "tool-send_message_to_agent";
  const isWait = type === "tool-wait_for_agents";
  const isLegacy = type === "tool-delegate_task";
  const sidebarContent = useMemo<SidebarSubagents>(
    () => ({
      kind: "subagents",
      parentMessageId,
      toolCallId,
      ...(!isCreate && !isLegacy && agentId
        ? { selectedSubagentId: agentId }
        : {}),
    }),
    [agentId, isCreate, isLegacy, parentMessageId, toolCallId],
  );
  const { handleOpenInSidebar, handleKeyDown } = useToolSidebar({
    toolCallId,
    content: sidebarContent,
    typeGuard: isSidebarSubagents,
  });

  const hasChildLifecycle = Boolean(lifecycle?.data?.subagent_id);
  const failed = Boolean(errorText) || output?.success === false;
  const legacyCanOpen =
    !errorText && (output?.status !== "failed" || hasChildLifecycle);
  const canOpenSidebar =
    state !== "input-streaming" &&
    (isLegacy
      ? legacyCanOpen
      : hasChildLifecycle ||
        (isCreate && output?.success === true) ||
        ((isSend || isWait) && output?.success === true && agentId));
  const waiting =
    state === "input-streaming" ||
    (state === "input-available" && status === "streaming");

  let action: string;
  if (isCreate) {
    action = failed
      ? `${agentName} failed to start`
      : waiting
        ? `${agentName} starting`
        : `${agentName} started working`;
  } else if (isSend) {
    action = failed
      ? `${agentName} update failed`
      : waiting
        ? `${agentName} updating`
        : `${agentName} updated`;
  } else if (isWait) {
    const terminalStatus = output?.result?.status ?? lifecycle?.data?.status;
    action = waiting
      ? "Waiting for subagents"
      : output?.wait_outcome === "timeout"
        ? "Subagent wait timed out"
        : output?.wait_outcome === "no_active_agents"
          ? "No active subagents"
          : terminalStatus && terminalStatus !== "completed"
            ? `${agentName} ${terminalStatus.replaceAll("_", " ")}`
            : `${agentName} finished`;
  } else {
    action =
      output?.status && output.status !== "completed"
        ? `${agentName} failed`
        : output?.status === "completed"
          ? `${agentName} completed`
          : waiting
            ? `${agentName} working`
            : errorText
              ? `${agentName} failed`
              : agentName;
  }

  return (
    <ToolBlock
      icon={<Bot />}
      action={action}
      isShimmer={waiting}
      isClickable={Boolean(canOpenSidebar)}
      onClick={handleOpenInSidebar}
      onKeyDown={handleKeyDown}
      accessibleLabel={canOpenSidebar ? `Open ${agentName} in sidebar` : action}
    />
  );
});
