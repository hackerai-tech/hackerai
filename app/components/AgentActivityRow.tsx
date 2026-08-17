"use client";

import { memo, useMemo } from "react";
import { MessagePartHandler } from "./MessagePartHandler";
import { SubagentToolGroup } from "./tools/SubagentToolHandler";
import type { AgentWorkActivityPart } from "./worked-for-parts";
import type { ChatMessage, ChatStatus } from "@/types";
import type { FileDetails } from "@/types/file";

type AgentActivityRowProps = {
  deferReasoningCollapseUntilParent: boolean;
  isLastMessage: boolean;
  keepLatestReasoningOpenDuringStreaming: boolean;
  suppressReasoningAutoOpen: boolean;
  message: ChatMessage;
  part: ChatMessage["parts"][number];
  partIndex: number;
  groupedParts?: AgentWorkActivityPart[];
  sharedFileDetails?: FileDetails[];
  status: ChatStatus;
  terminalChunksByToolCallId: Map<string, readonly string[]>;
};

export const AgentActivityRow = memo(function AgentActivityRow({
  deferReasoningCollapseUntilParent,
  isLastMessage,
  keepLatestReasoningOpenDuringStreaming,
  suppressReasoningAutoOpen,
  message,
  part,
  partIndex,
  groupedParts,
  sharedFileDetails,
  status,
  terminalChunksByToolCallId,
}: AgentActivityRowProps) {
  const terminalOutputByToolCallId = useMemo(() => {
    const toolCallId =
      (part as { data?: { toolCallId?: unknown } }).data?.toolCallId ??
      (part as { toolCallId?: unknown }).toolCallId;
    if (typeof toolCallId !== "string") return new Map<string, string>();

    return new Map([
      [toolCallId, (terminalChunksByToolCallId.get(toolCallId) ?? []).join("")],
    ]);
  }, [part, terminalChunksByToolCallId]);

  return (
    <div
      className="w-full min-w-0 overflow-hidden text-foreground"
      data-testid="agent-activity-row"
    >
      <div className="prose max-w-none min-w-0 overflow-hidden dark:prose-invert">
        {groupedParts ? (
          <SubagentToolGroup
            message={message}
            parts={groupedParts.map(({ part: groupedPart }) => groupedPart)}
            status={status}
          />
        ) : (
          <MessagePartHandler
            message={message}
            part={part}
            partIndex={partIndex}
            status={status}
            isLastMessage={isLastMessage}
            keepLatestReasoningOpenDuringStreaming={
              keepLatestReasoningOpenDuringStreaming
            }
            suppressReasoningAutoOpen={suppressReasoningAutoOpen}
            deferReasoningCollapseUntilParent={
              deferReasoningCollapseUntilParent
            }
            terminalOutputByToolCallId={terminalOutputByToolCallId}
            sharedFileDetails={sharedFileDetails}
          />
        )}
      </div>
    </div>
  );
});
