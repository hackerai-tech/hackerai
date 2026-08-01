"use client";

import { memo, useMemo } from "react";
import { ShieldCheck, Users } from "lucide-react";
import type { UIMessage } from "@ai-sdk/react";

import ToolBlock from "@/components/ui/tool-block";
import type { ChatStatus, SidebarSubagents } from "@/types/chat";
import { isSidebarSubagents } from "@/types/chat";
import { useToolSidebar } from "@/app/hooks/useToolSidebar";

type DelegateOutput = {
  subagent_id?: string;
  status?: string;
  verdict?: "confirmed" | "rejected" | "inconclusive" | null;
  summary?: string;
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
  const title = input?.profile_input?.candidate?.title ?? "candidate";
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
  const action =
    result?.status && result.status !== "completed"
      ? "Validation failed"
      : result?.verdict === "confirmed"
        ? "Confirmed independently"
        : result?.verdict === "rejected"
          ? "Rejected independently"
          : result?.verdict === "inconclusive"
            ? "Validation inconclusive"
            : state === "input-streaming"
              ? "Preparing independent validation"
              : status === "streaming"
                ? "Validating independently"
                : errorText
                  ? "Validation failed"
                  : "Independent validation";

  return (
    <ToolBlock
      icon={<Users />}
      action={action}
      target={title}
      isShimmer={
        state === "input-streaming" ||
        (state === "input-available" && status === "streaming")
      }
      isClickable={state !== "input-streaming"}
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
