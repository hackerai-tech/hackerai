"use client";

import { memo, useMemo } from "react";
import { Bot, ShieldCheck } from "lucide-react";
import type { UIMessage } from "@ai-sdk/react";

import ToolBlock from "@/components/ui/tool-block";
import type { ChatStatus, SidebarSubagents } from "@/types/chat";
import { isSidebarSubagents } from "@/types/chat";
import { useToolSidebar } from "@/app/hooks/useToolSidebar";

type DelegateOutput = {
  subagent_id?: string;
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
  const sidebarContent = useMemo<SidebarSubagents>(
    () => ({
      kind: "subagents",
      parentMessageId: message.id,
      toolCallId,
      selectedSubagentId: output?.subagent_id,
    }),
    [message.id, output?.subagent_id, toolCallId],
  );
  const { handleOpenInSidebar, handleKeyDown } = useToolSidebar({
    toolCallId,
    content: sidebarContent,
    typeGuard: isSidebarSubagents,
  });

  const result = output as DelegateOutput | undefined;
  const canOpenSidebar =
    state !== "input-streaming" && (!errorText || !!result?.subagent_id);
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

export const VulnerabilityReportToolHandler = memo(
  function VulnerabilityReportToolHandler({ part }: { part: any }) {
    const output = part.output as
      { success?: boolean; reportId?: string; reason?: string } | undefined;
    return (
      <ToolBlock
        icon={<ShieldCheck />}
        action={
          output?.success
            ? "Saved validated report"
            : part.state === "input-streaming" ||
                part.state === "input-available"
              ? "Promoting validated report"
              : "Report promotion blocked"
        }
        target={output?.reportId ?? part.input?.title}
        isShimmer={
          part.state === "input-streaming" || part.state === "input-available"
        }
      />
    );
  },
);
