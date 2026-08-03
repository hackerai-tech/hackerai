"use client";

import { memo, useMemo } from "react";
import { Bot } from "lucide-react";
import type { UIMessage } from "@ai-sdk/react";

import ToolBlock from "@/components/ui/tool-block";
import type { ChatStatus, SidebarSubagents } from "@/types/chat";
import { isSidebarSubagents } from "@/types/chat";
import { useToolSidebar } from "@/app/hooks/useToolSidebar";

type DelegateOutput = {
  status?: string;
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
  const { toolCallId, state, input, output, errorText } = part;
  const title =
    input?.profile_input?.candidate?.title ??
    input?.objective ??
    "Delegated task";
  const hasChildLifecycle = message.parts.some(
    (candidate: any) =>
      candidate?.type === "data-subagent-lifecycle" &&
      candidate?.data?.parent_tool_call_id === toolCallId,
  );
  const sidebarContent = useMemo<SidebarSubagents>(
    () => ({
      kind: "subagents",
      parentMessageId: message.id,
      toolCallId,
    }),
    [message.id, toolCallId],
  );
  const { handleOpenInSidebar, handleKeyDown } = useToolSidebar({
    toolCallId,
    content: sidebarContent,
    typeGuard: isSidebarSubagents,
  });

  const result = output as DelegateOutput | undefined;
  const canOpenSidebar =
    state !== "input-streaming" &&
    !errorText &&
    (result?.status !== "failed" || hasChildLifecycle);
  const action =
    result?.status && result.status !== "completed"
      ? "Subagent failed"
      : result?.status === "completed"
        ? "Subagent completed"
        : state === "input-streaming"
          ? "Starting subagent"
          : status === "streaming"
            ? "Subagent working"
            : errorText
              ? "Subagent failed"
              : "Delegated task";

  return (
    <ToolBlock
      icon={<Bot />}
      action={action}
      target={title}
      isShimmer={
        state === "input-streaming" ||
        (state === "input-available" && status === "streaming")
      }
      isClickable={canOpenSidebar}
      onClick={handleOpenInSidebar}
      onKeyDown={handleKeyDown}
    />
  );
});
