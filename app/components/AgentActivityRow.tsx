"use client";

import { memo, useMemo } from "react";
import { MessagePartHandler } from "./MessagePartHandler";
import type { ChatMessage, ChatStatus } from "@/types";
import type { FileDetails } from "@/types/file";

type AgentActivityRowProps = {
  deferReasoningCollapseUntilParent: boolean;
  isLastMessage: boolean;
  keepLatestReasoningOpenDuringStreaming: boolean;
  message: ChatMessage;
  part: ChatMessage["parts"][number];
  partIndex: number;
  sharedFileDetails?: FileDetails[];
  status: ChatStatus;
  terminalChunksByToolCallId: Map<string, readonly string[]>;
};

export const AgentActivityRow = memo(function AgentActivityRow({
  deferReasoningCollapseUntilParent,
  isLastMessage,
  keepLatestReasoningOpenDuringStreaming,
  message,
  part,
  partIndex,
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
      className="message-row w-full min-w-0 overflow-hidden text-foreground"
      data-testid="agent-activity-row"
    >
      <div className="prose max-w-none min-w-0 overflow-hidden dark:prose-invert">
        <MessagePartHandler
          message={message}
          part={part}
          partIndex={partIndex}
          status={status}
          isLastMessage={isLastMessage}
          keepLatestReasoningOpenDuringStreaming={
            keepLatestReasoningOpenDuringStreaming
          }
          deferReasoningCollapseUntilParent={deferReasoningCollapseUntilParent}
          terminalOutputByToolCallId={terminalOutputByToolCallId}
          sharedFileDetails={sharedFileDetails}
        />
      </div>
    </div>
  );
});
